import axios from "npm:axios@1.12.2";
import nacl from "npm:tweetnacl@1.0.3";

/*
Deno Deploy endpoint for Discord `/backtest`.

Required Pipedream environment variables:
  DISCORD_PUBLIC_KEY
  DISCORD_BOT_TOKEN
*/

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function hexToBytes(hex: string) {
  return new Uint8Array(hex.match(/.{1,2}/g)?.map((x) => Number.parseInt(x, 16)) ?? []);
}

Deno.serve(async (request: Request) => {
  const requestUrl = new URL(request.url);

  // One-time protected route for registering `/backtest` globally.
  if (request.method === "GET" && requestUrl.pathname === "/register-global") {
    const suppliedKey = requestUrl.searchParams.get("key");
    const registerSecret = Deno.env.get("REGISTER_SECRET");
    if (!registerSecret || suppliedKey !== registerSecret) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    try {
      const command = await registerGlobalCommand();
      return jsonResponse({
        success: true,
        message: "/backtest berhasil didaftarkan sebagai global command",
        command_id: command.id,
        command_name: command.name,
      });
    } catch (error) {
      return jsonResponse({ success: false, error: discordErrorDetail(error) }, 500);
    }
  }

  if (request.method === "GET") {
    return jsonResponse({ success: true, service: "Discord IDX Backtester", status: "ready" });
  }
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const publicKey = Deno.env.get("DISCORD_PUBLIC_KEY");
  const botToken = Deno.env.get("DISCORD_BOT_TOKEN");
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  const rawBody = await request.text();

  if (!publicKey || !signature || !timestamp) return jsonResponse({ error: "Unauthorized" }, 401);
  const valid = nacl.sign.detached.verify(
    new TextEncoder().encode(timestamp + rawBody),
    hexToBytes(signature),
    hexToBytes(publicKey),
  );
  if (!valid) return jsonResponse({ error: "Invalid Discord signature" }, 401);

  const interaction = JSON.parse(rawBody);
  if (interaction.type === 1) return jsonResponse({ type: 1 });
  if (interaction.type !== 2 || interaction.data?.name !== "backtest") {
    return jsonResponse({ type: 4, data: { content: "Command tidak dikenali.", flags: 64 } });
  }

  const options = Object.fromEntries(
    (interaction.data.options || []).map((option: { name: string; value: unknown }) => [option.name, option.value]),
  );
  const ticker = normalizeTicker(options.ticker || "DMAS");
  const feeBuy = Number(options.fee_beli ?? 0.15) / 100;
  const feeSell = Number(options.fee_jual ?? 0.25) / 100;
  const slippage = Number(options.slippage ?? 0.10) / 100;

  // Return immediately; the dynamic Deno service continues the queued work.
  setTimeout(() => {
    runBacktestJob(interaction.channel_id, botToken, ticker, feeBuy, feeSell, slippage)
      .catch((error) => console.error("Backtest job failed", error));
  }, 0);

  return jsonResponse({
    type: 4,
    data: { content: `⏳ Backtest **${ticker}** sedang diproses…` },
  });
});

async function registerGlobalCommand() {
  const applicationId = Deno.env.get("DISCORD_APPLICATION_ID");
  const botToken = Deno.env.get("DISCORD_BOT_TOKEN");
  if (!applicationId) throw new Error("DISCORD_APPLICATION_ID belum diisi.");
  if (!botToken) throw new Error("DISCORD_BOT_TOKEN belum diisi.");

  const command = {
    name: "backtest",
    type: 1,
    description: "Cari strategi terbaik dan rekomendasi entry saham IDX",
    options: [
      { name: "ticker", description: "Kode emiten, contoh DMAS", type: 3, required: true, min_length: 2, max_length: 12 },
      { name: "fee_beli", description: "Fee beli persen, default 0.15", type: 10, required: false, min_value: 0, max_value: 2 },
      { name: "fee_jual", description: "Fee jual persen, default 0.25", type: 10, required: false, min_value: 0, max_value: 2 },
      { name: "slippage", description: "Slippage persen, default 0.10", type: 10, required: false, min_value: 0, max_value: 2 },
    ],
  };

  const response = await axios.post(
    `https://discord.com/api/v10/applications/${applicationId}/commands`,
    command,
    {
      headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      timeout: 30000,
    },
  );
  return response.data;
}

async function runBacktestJob(
  channelId: string,
  botToken: string | undefined,
  ticker: string,
  feeBuy: number,
  feeSell: number,
  slippage: number,
) {
  try {
    const bars5 = await fetchYahooBars(ticker, "60d", "5m");
    if (bars5.length < 250) throw new Error("Data 5m terlalu sedikit untuk backtest.");
    const bars15 = resampleBars(bars5, 15);
    const enriched5 = enrich(bars5);
    const enriched15 = enrich(bars15);
    mapHigherTimeframe(enriched5, enriched15);
    const splitIndex = Math.floor(enriched5.length * 0.70);
    const results = strategyConfigs().map((config) => {
      const full = backtest(enriched5, config, feeBuy, feeSell, slippage, 0, enriched5.length);
      const train = backtest(enriched5, config, feeBuy, feeSell, slippage, 0, splitIndex);
      const test = backtest(enriched5, config, feeBuy, feeSell, slippage, splitIndex, enriched5.length);
      return { ...config, full, train, test, score: scoreResult(full, test) };
    }).sort((a, b) => b.score - a.score);
    const qualified = results.filter((r) =>
      r.full.trades >= 15 && r.test.trades >= 4 && r.full.profitFactor > 1 &&
      r.test.netReturnPct > 0 && r.test.profitFactor > 1
    );
    const winner = qualified[0] || results[0];
    const recommendation = buildRecommendation(enriched5, winner);
    await sendChannelMessage(channelId, botToken, formatDiscordReport(ticker, enriched5, results, winner, recommendation));
  } catch (error) {
    const detail = discordErrorDetail(error);
    try {
      await sendChannelMessage(channelId, botToken, `❌ **Backtest ${ticker} gagal**\n${detail.slice(0, 1500)}`);
    } catch (sendError) {
      console.error("Could not send error to Discord", sendError);
    }
  }
}

function normalizeTicker(value) {
  const clean = String(value).trim().toUpperCase().replace(/[^A-Z0-9.^-]/g, "");
  if (!clean) throw new Error("Ticker kosong.");
  return clean.includes(".") || clean.startsWith("^") ? clean : `${clean}.JK`;
}

async function fetchYahooBars(ticker, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`;
  const response = await axios.get(url, {
    params: { range, interval, includePrePost: false, events: "div,splits" },
    timeout: 30000,
    headers: { "User-Agent": "Mozilla/5.0 Pipedream IDX Backtester", Accept: "application/json" },
  });
  const result = response.data?.chart?.result?.[0];
  if (!result) throw new Error(response.data?.chart?.error?.description || "Yahoo tidak mengembalikan data.");
  const q = result.indicators?.quote?.[0] || {};
  return (result.timestamp || []).map((time, i) => ({
    time, open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close?.[i], volume: q.volume?.[i] || 0,
  })).filter((b) => [b.open, b.high, b.low, b.close].every(Number.isFinite))
    .sort((a, b) => a.time - b.time);
}

function resampleBars(bars, minutes) {
  const seconds = minutes * 60;
  const groups = new Map();
  for (const b of bars) {
    const key = Math.floor(b.time / seconds) * seconds;
    const g = groups.get(key);
    if (!g) groups.set(key, { ...b, time: key });
    else {
      g.high = Math.max(g.high, b.high); g.low = Math.min(g.low, b.low);
      g.close = b.close; g.volume += b.volume;
    }
  }
  return [...groups.values()].sort((a, b) => a.time - b.time);
}

function rollingMax(bars, i, n, field) {
  if (i < n - 1) return null;
  let v = -Infinity; for (let j = i - n + 1; j <= i; j++) v = Math.max(v, bars[j][field]); return v;
}
function rollingMin(bars, i, n, field) {
  if (i < n - 1) return null;
  let v = Infinity; for (let j = i - n + 1; j <= i; j++) v = Math.min(v, bars[j][field]); return v;
}
function sma(bars, i, n, field = "close") {
  if (i < n - 1) return null;
  let s = 0; for (let j = i - n + 1; j <= i; j++) s += bars[j][field]; return s / n;
}
function std(bars, i, n) {
  const m = sma(bars, i, n); if (m == null) return null;
  let s = 0; for (let j = i - n + 1; j <= i; j++) s += (bars[j].close - m) ** 2;
  return Math.sqrt(s / n);
}

function enrich(input) {
  const bars = input.map((b) => ({ ...b }));
  let ema9 = null, ema21 = null, avgGain = null, avgLoss = null, atr = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    ema9 = ema9 == null ? b.close : b.close * 0.2 + ema9 * 0.8;
    ema21 = ema21 == null ? b.close : b.close * (2 / 22) + ema21 * (20 / 22);
    b.ema9 = ema9; b.ema21 = ema21;
    if (i > 0) {
      const change = b.close - bars[i - 1].close;
      const gain = Math.max(change, 0), loss = Math.max(-change, 0);
      avgGain = avgGain == null ? gain : (avgGain * 13 + gain) / 14;
      avgLoss = avgLoss == null ? loss : (avgLoss * 13 + loss) / 14;
      const tr = Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close));
      atr = atr == null ? tr : (atr * 13 + tr) / 14;
    }
    b.rsi = avgLoss === 0 ? 100 : avgGain == null ? null : 100 - 100 / (1 + avgGain / avgLoss);
    b.atr = atr;
    b.volSma20 = sma(bars, i, 20, "volume");
    b.bbMid = sma(bars, i, 20); const sd = std(bars, i, 20);
    b.bbUpper = sd == null ? null : b.bbMid + 2 * sd; b.bbLower = sd == null ? null : b.bbMid - 2 * sd;
    const h9 = rollingMax(bars, i, 9, "high"), l9 = rollingMin(bars, i, 9, "low");
    const h26 = rollingMax(bars, i, 26, "high"), l26 = rollingMin(bars, i, 26, "low");
    const h52 = rollingMax(bars, i, 52, "high"), l52 = rollingMin(bars, i, 52, "low");
    b.tenkan = h9 == null ? null : (h9 + l9) / 2;
    b.kijun = h26 == null ? null : (h26 + l26) / 2;
    if (i + 26 < bars.length && b.tenkan != null && b.kijun != null) bars[i + 26].spanA = (b.tenkan + b.kijun) / 2;
    if (i + 26 < bars.length && h52 != null) bars[i + 26].spanB = (h52 + l52) / 2;
  }
  return bars;
}

function mapHigherTimeframe(bars5, bars15) {
  let j = 0;
  for (const b of bars5) {
    while (j + 1 < bars15.length && bars15[j + 1].time <= b.time) j++;
    b.htf = bars15[j]?.time <= b.time ? bars15[j] : null;
  }
}

function strategyConfigs() {
  return [
    { id: "ichi_pullback", name: "Ichimoku Pullback + Volume", stopATR: 1.2, takeR: 2.0, maxBars: 18 },
    { id: "ichi_cross", name: "Ichimoku Tenkan–Kijun Cross", stopATR: 1.4, takeR: 2.0, maxBars: 24 },
    { id: "ichi_breakout", name: "Ichimoku Kumo Breakout", stopATR: 1.5, takeR: 2.2, maxBars: 24 },
    { id: "bb_mean", name: "Bollinger Mean Reversion", stopATR: 1.2, takeR: 1.5, maxBars: 15 },
    { id: "bb_breakout", name: "Bollinger Breakout + Volume", stopATR: 1.5, takeR: 2.0, maxBars: 20 },
    { id: "ema_pullback", name: "EMA 9/21 Pullback", stopATR: 1.2, takeR: 1.8, maxBars: 18 },
    { id: "rsi_pullback", name: "RSI Trend Pullback", stopATR: 1.2, takeR: 1.8, maxBars: 18 },
  ];
}

function signalAt(bars, i, id) {
  const b = bars[i], p = bars[i - 1];
  if (!p || !b.htf || !b.atr || !b.volSma20) return false;
  const top = Math.max(b.spanA ?? Infinity, b.spanB ?? Infinity);
  const pTop = Math.max(p.spanA ?? Infinity, p.spanB ?? Infinity);
  const h = b.htf, hTop = Math.max(h.spanA ?? Infinity, h.spanB ?? Infinity);
  const trend = h.close > hTop && h.tenkan > h.kijun;
  const volume = b.volume > b.volSma20 * 1.05;
  if (id === "ichi_pullback") return trend && b.close > top && p.low <= p.kijun * 1.004 && b.close > b.kijun && b.close > p.close && volume;
  if (id === "ichi_cross") return trend && p.tenkan <= p.kijun && b.tenkan > b.kijun && b.close > top;
  if (id === "ichi_breakout") return trend && p.close <= pTop && b.close > top && volume;
  if (id === "bb_mean") return trend && p.close < p.bbLower && b.close > b.bbLower && b.rsi < 45;
  if (id === "bb_breakout") return trend && p.close <= p.bbUpper && b.close > b.bbUpper && volume;
  if (id === "ema_pullback") return trend && b.ema9 > b.ema21 && p.low <= p.ema21 * 1.003 && b.close > b.ema9 && b.close > p.close;
  if (id === "rsi_pullback") return trend && b.close > b.ema21 && p.rsi < 40 && b.rsi >= 40;
  return false;
}

function backtest(bars, config, feeBuy, feeSell, slippage, start, end) {
  let equity = 1, peak = 1, maxDD = 0, wins = 0, grossWin = 0, grossLoss = 0, trades = 0;
  for (let i = Math.max(start, 80); i < end - 1; i++) {
    if (!signalAt(bars, i, config.id)) continue;
    const entryIndex = i + 1;
    const entry = bars[entryIndex].open * (1 + slippage + feeBuy);
    const atr = bars[i].atr; if (!atr || atr <= 0) continue;
    const stop = entry - config.stopATR * atr;
    const target = entry + config.takeR * (entry - stop);
    let exit = bars[Math.min(entryIndex + config.maxBars, end - 1)].close * (1 - slippage - feeSell);
    let exitIndex = Math.min(entryIndex + config.maxBars, end - 1);
    for (let j = entryIndex; j <= exitIndex; j++) {
      // Conservative same-bar rule: if both hit, stop is assumed first.
      if (bars[j].low <= stop) { exit = stop * (1 - slippage - feeSell); exitIndex = j; break; }
      if (bars[j].high >= target) { exit = target * (1 - slippage - feeSell); exitIndex = j; break; }
    }
    const ret = exit / entry - 1;
    equity *= 1 + ret; trades++;
    if (ret > 0) { wins++; grossWin += ret; } else grossLoss += Math.abs(ret);
    peak = Math.max(peak, equity); maxDD = Math.max(maxDD, (peak - equity) / peak);
    i = exitIndex;
  }
  return {
    trades, winRate: trades ? wins / trades : 0, netReturnPct: (equity - 1) * 100,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    maxDrawdownPct: maxDD * 100, expectancyPct: trades ? ((equity ** (1 / trades)) - 1) * 100 : 0,
  };
}

function scoreResult(full, test) {
  if (full.trades < 5 || test.trades < 2) return -999;
  const pf = Math.min(full.profitFactor, 3), testPf = Math.min(test.profitFactor, 3);
  return full.netReturnPct * 0.2 + test.netReturnPct * 0.35 + pf * 8 + testPf * 12 - full.maxDrawdownPct * 0.7 + Math.min(full.trades, 40) * 0.15;
}

function buildRecommendation(bars, winner) {
  const b = bars.at(-1), p = bars.at(-2);
  const cloudTop = Math.max(b.spanA ?? b.close, b.spanB ?? b.close);
  const trend = b.htf && b.htf.close > Math.max(b.htf.spanA ?? Infinity, b.htf.spanB ?? Infinity) && b.htf.tenkan > b.htf.kijun;
  const active = signalAt(bars, bars.length - 1, winner.id);
  const resistance = rollingMax(bars, bars.length - 2, 20, "high");
  const support = Math.max(b.kijun || 0, b.ema21 || 0, cloudTop || 0);
  const risk = Math.max((b.atr || b.close * 0.01) * winner.stopATR, b.close * 0.008);
  if (!trend) return { status: "NO TRADE", reason: "Filter tren 15m belum bullish", trigger: null };
  if (active) return { status: "ENTRY SETUP AKTIF", reason: `Sinyal ${winner.name} baru terkonfirmasi`, trigger: b.high, stop: b.high - risk, target1: b.high + risk, target2: b.high + risk * winner.takeR };
  if (b.close > resistance * 0.997) return { status: "TUNGGU BREAKOUT", reason: "Harga dekat resistance; tunggu candle 5m close di atas trigger dengan volume", trigger: resistance, stop: resistance - risk, target1: resistance + risk, target2: resistance + risk * winner.takeR };
  return { status: "TUNGGU PULLBACK", reason: "Tren bullish tetapi belum ada trigger strategi pemenang", trigger: support, stop: support - risk, target1: support + risk, target2: support + risk * winner.takeR };
}

function rupiahPrice(n) { return n == null || !Number.isFinite(n) ? "–" : n.toFixed(2).replace(/\.00$/, ""); }
function pct(n) { return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`; }
function pf(n) { return n >= 99 ? "∞" : n.toFixed(2); }
function wib(unix) { return new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" }).format(new Date(unix * 1000)); }

function formatDiscordReport(ticker, bars, results, winner, rec) {
  const latest = bars.at(-1);
  const rows = results.slice(0, 5).map((r, i) =>
    `${i + 1}. **${r.name}** — Return ${pct(r.full.netReturnPct)} | PF ${pf(r.full.profitFactor)} | DD -${r.full.maxDrawdownPct.toFixed(2)}% | ${r.full.trades} trade | OOS ${pct(r.test.netReturnPct)}`,
  ).join("\n");
  const levels = rec.trigger == null ? "Trigger: –" : `Trigger: **${rupiahPrice(rec.trigger)}** | SL: **${rupiahPrice(rec.stop)}** | TP1: **${rupiahPrice(rec.target1)}** | TP2: **${rupiahPrice(rec.target2)}**`;
  return [
    `📊 **BACKTEST ${ticker} — 5m / 60 hari**`,
    `Data terakhir: ${wib(latest.time)} | Close: **${rupiahPrice(latest.close)}**`, "",
    rows, "",
    `🏆 **Pemenang: ${winner.name}**`,
    `Full: ${pct(winner.full.netReturnPct)} | WR ${(winner.full.winRate * 100).toFixed(1)}% | PF ${pf(winner.full.profitFactor)} | Max DD -${winner.full.maxDrawdownPct.toFixed(2)}%`,
    `Out-of-sample 30%: ${pct(winner.test.netReturnPct)} | PF ${pf(winner.test.profitFactor)} | ${winner.test.trades} trade`, "",
    `🎯 **${rec.status}**`, rec.reason, levels, "",
    "Entry dilakukan setelah candle 5m selesai/close, bukan saat masih berjalan. Ukuran posisi wajib disesuaikan dengan batas risiko.",
    "_Backtest historis bukan jaminan hasil berikutnya._",
  ].join("\n").slice(0, 1950);
}

async function sendChannelMessage(channelId, botToken, content) {
  if (!channelId) throw new Error("Discord interaction tidak memiliki channel_id.");
  if (!botToken) throw new Error("DISCORD_BOT_TOKEN belum disimpan di Pipedream.");
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  await axios.post(
    url,
    { content, allowed_mentions: { parse: [] } },
    { headers: { Authorization: `Bot ${botToken}` }, timeout: 30000 },
  );
}

function discordErrorDetail(error) {
  const status = error.response?.status;
  const api = error.response?.data;
  const apiText = api ? JSON.stringify(api) : error.message;
  return `${status ? `HTTP ${status}: ` : ""}${apiText}`;
}
