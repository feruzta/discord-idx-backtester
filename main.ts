import axios from "npm:axios@1.12.2";
import nacl from "npm:tweetnacl@1.0.3";
import * as cheerio from "npm:cheerio@1.1.2";
import { IDX_SYMBOLS, IDX_SYMBOLS_UPDATED_AT } from "./idx_symbols.ts";

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ScannerCandle extends Candle {
  ema8: number;
  ema21: number;
  ema125: number;
  atr14: number | null;
  volumeSma20: number | null;
}

type SetupStatus =
  | "NO_SETUP" | "BULLISH_TREND" | "WAIT_PULLBACK" | "PULLBACK"
  | "WAIT_CONFIRMATION" | "WAIT_BREAKOUT" | "READY_BUY" | "INVALID";

/*
Deno Deploy endpoint for Discord `/backtest`, `/technical`, and `/scan`.

Required Deno Deploy environment variables:
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

  // One-time protected route for registering all Discord commands globally.
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
        message: "/backtest, /technical, dan /scan berhasil didaftarkan sebagai global command",
        commands: [command.backtest.name, command.technical.name, command.scan.name],
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
  const commandName = interaction.data?.name;
  if (interaction.type !== 2 || !["backtest", "technical", "scan"].includes(commandName)) {
    return jsonResponse({ type: 4, data: { content: "Command tidak dikenali.", flags: 64 } });
  }

  const options = Object.fromEntries(
    (interaction.data.options || []).map((option: { name: string; value: unknown }) => [option.name, option.value]),
  );

  if (commandName === "scan") {
    const supplied = String(options.symbols ?? "");
    const symbols = supplied
      ? [...new Set(supplied.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))]
      : IDX_SYMBOLS;
    setTimeout(() => {
      runScannerJob(interaction.channel_id, botToken, symbols)
        .catch((error) => console.error("Scanner job failed", error));
    }, 0);
    return jsonResponse({
      type: 4,
      data: { content: `🔎 Memeriksa lonjakan volume **${symbols.length} emiten**. Top 10 akan diperkaya dengan frequency + broker summary, lalu dianalisis pada 15m + 5m…` },
    });
  }

  const ticker = normalizeTicker(options.ticker || "DMAS");

  if (commandName === "technical") {
    setTimeout(() => {
      runTechnicalJob(interaction.channel_id, botToken, ticker)
        .catch((error) => console.error("Technical job failed", error));
    }, 0);
    return jsonResponse({
      type: 4,
      data: { content: `⏳ Analisis Daily **${ticker}** sedang diproses…` },
    });
  }

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

  const backtestCommand = {
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

  const technicalCommand = {
    name: "technical",
    type: 1,
    description: "Analisis teknikal Daily dan rencana entry saham IDX",
    options: [
      { name: "ticker", description: "Kode emiten, contoh DMAS", type: 3, required: true, min_length: 2, max_length: 12 },
    ],
  };

  const scanCommand = {
    name: "scan",
    type: 1,
    description: "Scan setup EMA 8/21/125 pada daftar saham IDX",
    options: [
      { name: "symbols", description: "Opsional untuk test, contoh DMAS,BBCA,IMJS; kosong scan seluruh IDX", type: 3, required: false, max_length: 500 },
    ],
  };

  const first = await axios.post(
    `https://discord.com/api/v10/applications/${applicationId}/commands`,
    backtestCommand,
    {
      headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      timeout: 30000,
    },
  );
  const second = await axios.post(
    `https://discord.com/api/v10/applications/${applicationId}/commands`,
    technicalCommand,
    {
      headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      timeout: 30000,
    },
  );
  const third = await axios.post(
    `https://discord.com/api/v10/applications/${applicationId}/commands`,
    scanCommand,
    {
      headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      timeout: 30000,
    },
  );
  return { backtest: first.data, technical: second.data, scan: third.data };
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

async function runTechnicalJob(channelId: string, botToken: string | undefined, ticker: string) {
  try {
    let daily = await fetchYahooBars(ticker, "2y", "1d");
    if (daily.length < 220) throw new Error("Data Daily kurang dari 220 candle; analisis EMA200 belum layak.");
    const candleStatus = latestDailyCandleStatus(daily.at(-1).time);
    if (candleStatus === "berjalan" && daily.length > 220) daily = daily.slice(0, -1);
    const bars = enrich(daily);
    const analysis = analyzeDaily(bars);
    await sendChannelMessage(channelId, botToken, formatTechnicalReport(ticker, bars, analysis, candleStatus));
  } catch (error) {
    const detail = discordErrorDetail(error);
    try {
      await sendChannelMessage(channelId, botToken, `❌ **Analisis ${ticker} gagal**\n${detail.slice(0, 1500)}`);
    } catch (sendError) {
      console.error("Could not send technical error", sendError);
    }
  }
}

const STATUS_PRIORITY: Record<SetupStatus, number> = {
  READY_BUY: 0,
  WAIT_BREAKOUT: 1,
  WAIT_CONFIRMATION: 2,
  PULLBACK: 3,
  WAIT_PULLBACK: 4,
  BULLISH_TREND: 5,
  NO_SETUP: 6,
  INVALID: 7,
};

async function runScannerJob(
  channelId: string,
  botToken: string | undefined,
  rawSymbols: string[],
) {
  const symbols = rawSymbols.map(normalizeTicker);
  const volumeCandidates = await findTopVolumeSpikes(symbols, 10);
  if (!volumeCandidates.length) {
    await sendChannelMessage(
      channelId,
      botToken,
      `🔎 **VOLUME PRE-SCREEN**\nTidak ada emiten dengan volume hari ini ≥2× rata-rata 7 hari dari ${symbols.length} ticker yang berhasil diperiksa.`,
    );
    return;
  }
  const enrichedCandidates = await mapWithConcurrency(volumeCandidates, 2, enrichMarketActivity);
  const results = await mapWithConcurrency(enrichedCandidates, 3, async (candidate): Promise<ScannerResult> => {
    const symbol = candidate.symbol;
    try {
      const [raw5m, raw15m] = await Promise.all([
        fetchYahooBars(symbol, "60d", "5m"),
        fetchYahooBars(symbol, "60d", "15m"),
      ]);
      const candles5m = prepareScannerCandles(onlyClosedCandles(raw5m, 5 * 60));
      const candles15m = prepareScannerCandles(onlyClosedCandles(raw15m, 15 * 60));
      return {
        ...analyzeSetup(candles5m, candles15m, symbol.replace(/\.JK$/, "")),
        volumeRatio7d: candidate.volumeRatio7d,
        frequency: candidate.frequency,
        averageLotsPerTrade: candidate.averageLotsPerTrade,
        brokerSignal: candidate.brokerSignal,
        brokerConfirmed: candidate.brokerSignal === "ACCUMULATION",
        topBuyer: candidate.topBuyer,
        topSeller: candidate.topSeller,
        foreignNetValue: candidate.foreignNetValue,
      };
    } catch (error) {
      return {
        ...scannerErrorResult(symbol.replace(/\.JK$/, ""), discordErrorDetail(error)),
        volumeRatio7d: candidate.volumeRatio7d,
        frequency: candidate.frequency,
        averageLotsPerTrade: candidate.averageLotsPerTrade,
        brokerSignal: candidate.brokerSignal,
        brokerConfirmed: candidate.brokerSignal === "ACCUMULATION",
        topBuyer: candidate.topBuyer,
        topSeller: candidate.topSeller,
        foreignNetValue: candidate.foreignNetValue,
      };
    }
  });

  results.sort((a, b) =>
    STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] ||
    Number(b.brokerConfirmed) - Number(a.brokerConfirmed) ||
    b.score - a.score ||
    a.proximityPct - b.proximityPct ||
    b.averageVolume20 - a.averageVolume20
  );
  await sendChannelMessage(channelId, botToken, formatScannerReport(results, symbols.length, volumeCandidates.length));
}

interface VolumeCandidate {
  symbol: string;
  currentVolume: number;
  averageVolume7d: number;
  volumeRatio7d: number;
}

type BrokerSignal = "ACCUMULATION" | "NEUTRAL" | "DISTRIBUTION" | "UNAVAILABLE";

interface EnrichedVolumeCandidate extends VolumeCandidate {
  frequency: number | null;
  averageLotsPerTrade: number | null;
  brokerSignal: BrokerSignal;
  topBuyer: string | null;
  topSeller: string | null;
  foreignNetValue: number | null;
}

interface BrokerRow {
  code: string;
  value: number;
}

async function enrichMarketActivity(candidate: VolumeCandidate): Promise<EnrichedVolumeCandidate> {
  const ticker = candidate.symbol.replace(/\.JK$/, "");
  const [frequency, broker] = await Promise.all([
    scrapeKontanFrequency(ticker),
    scrapeIpotBrokerSummary(ticker),
  ]);
  return {
    ...candidate,
    frequency,
    averageLotsPerTrade: frequency && frequency > 0 ? candidate.currentVolume / 100 / frequency : null,
    brokerSignal: broker.signal,
    topBuyer: broker.buyers[0]?.code ?? null,
    topSeller: broker.sellers[0]?.code ?? null,
    foreignNetValue: broker.foreignNetValue,
  };
}

async function fetchPublicHtml(url: string): Promise<string> {
  const response = await axios.get(url, {
    timeout: 30000,
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (compatible; IDXResearchBot/1.0)",
    },
  });
  return String(response.data);
}

async function scrapeKontanFrequency(ticker: string): Promise<number | null> {
  try {
    const html = await fetchPublicHtml(`https://pusatdata.kontan.co.id/quote/${encodeURIComponent(ticker)}`);
    const $ = cheerio.load(html);
    let frequency: number | null = null;
    $("tr").each((_, row) => {
      const cells = $(row).find("td");
      if ($(cells[0]).text().trim().toLowerCase() === "frequency") {
        const parsed = parsePlainNumber($(cells[1]).text());
        if (parsed > 0) frequency = parsed;
      }
    });
    return frequency;
  } catch {
    return null;
  }
}

async function scrapeIpotBrokerSummary(ticker: string): Promise<{
  buyers: BrokerRow[];
  sellers: BrokerRow[];
  foreignNetValue: number | null;
  signal: BrokerSignal;
}> {
  try {
    const html = await fetchPublicHtml(
      `https://www.indopremier.com/ipotnews/newsSmartSearch.php?code=${encodeURIComponent(ticker)}`,
    );
    const $ = cheerio.load(html);
    const table = $("table").filter((_, element) => {
      const headers = $(element).find("thead").text();
      return headers.includes("Buyer") && headers.includes("B.Val") && headers.includes("Seller");
    }).first();
    if (!table.length) return { buyers: [], sellers: [], foreignNetValue: null, signal: "UNAVAILABLE" };

    const buyers: BrokerRow[] = [];
    const sellers: BrokerRow[] = [];
    table.find("tbody tr").each((_, row) => {
      const cells = $(row).find("td").map((__, cell) => $(cell).text().trim()).get();
      if (cells.length < 9) return;
      const buyValue = parseScaledNumber(cells[2]);
      const sellValue = parseScaledNumber(cells[7]);
      if (cells[0] && buyValue > 0) buyers.push({ code: cells[0], value: buyValue });
      if (cells[5] && sellValue > 0) sellers.push({ code: cells[5], value: sellValue });
    });
    const footer = table.find("tfoot").text().replace(/\s+/g, " ");
    const foreignMatch = footer.match(/F\.\s*NVal\s*:\s*([+-]?[\d.,]+\s*[KMBT]?)/i);
    const foreignNetValue = foreignMatch ? parseScaledNumber(foreignMatch[1]) : null;
    const topBuyValue = buyers.slice(0, 3).reduce((sum, row) => sum + row.value, 0);
    const topSellValue = sellers.slice(0, 3).reduce((sum, row) => sum + row.value, 0);
    const ratio = topSellValue > 0 ? topBuyValue / topSellValue : 1;
    const signal: BrokerSignal = ratio >= 1.10 && (foreignNetValue == null || foreignNetValue >= 0)
      ? "ACCUMULATION"
      : ratio <= 0.90 && (foreignNetValue == null || foreignNetValue <= 0)
      ? "DISTRIBUTION"
      : "NEUTRAL";
    return { buyers, sellers, foreignNetValue, signal };
  } catch {
    return { buyers: [], sellers: [], foreignNetValue: null, signal: "UNAVAILABLE" };
  }
}

function parsePlainNumber(value: string): number {
  const normalized = value.trim().replace(/[^\d-]/g, "");
  return normalized ? Number(normalized) : 0;
}

function parseScaledNumber(value: string): number {
  const match = value.trim().toUpperCase().match(/([+-]?[\d.,]+)\s*([KMBT])?/);
  if (!match) return 0;
  const numeric = Number(match[1].replace(/,/g, ""));
  const multiplier = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2] as "K" | "M" | "B" | "T"] ?? 1;
  return numeric * multiplier;
}

async function findTopVolumeSpikes(symbols: string[], limit: number): Promise<VolumeCandidate[]> {
  const checked = await mapWithConcurrency(symbols, 6, async (symbol): Promise<VolumeCandidate | null> => {
    try {
      const daily = await fetchYahooBars(symbol, "1mo", "1d");
      if (daily.length < 8) return null;
      const currentVolume = daily.at(-1)!.volume;
      const previousSeven = daily.slice(-8, -1).map((c) => c.volume).filter((volume) => volume > 0);
      if (currentVolume <= 0 || previousSeven.length < 7) return null;
      const averageVolume7d = previousSeven.reduce((sum, volume) => sum + volume, 0) / previousSeven.length;
      const volumeRatio7d = currentVolume / averageVolume7d;
      return volumeRatio7d >= 2
        ? { symbol, currentVolume, averageVolume7d, volumeRatio7d }
        : null;
    } catch {
      return null;
    }
  });
  return checked
    .filter((candidate): candidate is VolumeCandidate => candidate != null)
    .sort((a, b) => b.volumeRatio7d - a.volumeRatio7d || b.currentVolume - a.currentVolume)
    .slice(0, limit);
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>) {
  const output = new Array<R>(items.length);
  let cursor = 0;
  async function consume() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return output;
}

function onlyClosedCandles(candles: Candle[], intervalSeconds: number): Candle[] {
  const now = Math.floor(Date.now() / 1000);
  return candles.filter((c) => c.time + intervalSeconds <= now);
}

function calculateEmaSeries(candles: Candle[], period: number): number[] {
  const alpha = 2 / (period + 1);
  const result = new Array<number>(candles.length);
  let value = candles[0]?.close ?? 0;
  for (let i = 0; i < candles.length; i++) {
    value = i === 0 ? candles[i].close : candles[i].close * alpha + value * (1 - alpha);
    result[i] = value;
  }
  return result;
}

function calculateAtrSeries(candles: Candle[], period = 14): Array<number | null> {
  const result: Array<number | null> = new Array(candles.length).fill(null);
  let atr = 0;
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    if (i < period) atr += tr;
    else if (i === period) {
      atr = (atr + tr) / period;
      result[i] = atr;
    } else {
      atr = (atr * (period - 1) + tr) / period;
      result[i] = atr;
    }
  }
  return result;
}

function prepareScannerCandles(candles: Candle[]): ScannerCandle[] {
  if (!candles.length) return [];
  const ema8 = calculateEmaSeries(candles, 8);
  const ema21 = calculateEmaSeries(candles, 21);
  const ema125 = calculateEmaSeries(candles, 125);
  const atr14 = calculateAtrSeries(candles, 14);
  return candles.map((c, i) => ({
    ...c,
    ema8: ema8[i],
    ema21: ema21[i],
    ema125: ema125[i],
    atr14: atr14[i],
    volumeSma20: i < 19 ? null : candles.slice(i - 19, i + 1).reduce((sum, x) => sum + x.volume, 0) / 20,
  }));
}

interface ConfirmedPivot {
  index: number;
  time: number;
  price: number;
}

function confirmedPivots(
  candles: ScannerCandle[],
  pivotLength = 3,
): { highs: ConfirmedPivot[]; lows: ConfirmedPivot[] } {
  const highs: ConfirmedPivot[] = [];
  const lows: ConfirmedPivot[] = [];
  // The loop stops pivotLength candles before the end, so every pivot has
  // three already-closed candles on its right and never uses future data.
  for (let i = pivotLength; i <= candles.length - 1 - pivotLength; i++) {
    let isHigh = true, isLow = true;
    for (let offset = 1; offset <= pivotLength; offset++) {
      isHigh &&= candles[i].high > candles[i - offset].high && candles[i].high > candles[i + offset].high;
      isLow &&= candles[i].low < candles[i - offset].low && candles[i].low < candles[i + offset].low;
    }
    if (isHigh) highs.push({ index: i, time: candles[i].time, price: candles[i].high });
    if (isLow) lows.push({ index: i, time: candles[i].time, price: candles[i].low });
  }
  return { highs, lows };
}

function idxTickSize(price: number): number {
  if (price < 200) return 1;
  if (price < 500) return 2;
  if (price < 2000) return 5;
  if (price < 5000) return 10;
  return 25;
}

function roundToIdxTick(price: number, direction: "up" | "down"): number {
  let candidate = Math.max(price, 1);
  for (let tries = 0; tries < 4; tries++) {
    const tick = idxTickSize(candidate);
    const rounded = (direction === "up" ? Math.ceil(candidate / tick) : Math.floor(candidate / tick)) * tick;
    if (idxTickSize(rounded) === tick) return rounded;
    candidate = rounded;
  }
  return candidate;
}

interface ScoreBreakdown {
  aboveEMA125: number;
  ema125Rising: number;
  emaAlignment: number;
  emaSlope: number;
  higherHigh: number;
  higherLow: number;
  pullback: number;
  structureHeld: number;
  confirmation: number;
  volume: number;
}

interface ScannerResult {
  symbol: string;
  score: number;
  status: SetupStatus;
  trend: string;
  ema8: number | null;
  ema21: number | null;
  ema125: number | null;
  atr14: number | null;
  latestPivotHigh: number | null;
  previousPivotHigh: number | null;
  latestPivotLow: number | null;
  previousPivotLow: number | null;
  higherHigh: boolean;
  higherLow: boolean;
  pullbackDetected: boolean;
  pullbackLow: number | null;
  confirmationDetected: boolean;
  confirmationHigh: number | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
  scoreBreakdown: ScoreBreakdown;
  proximityPct: number;
  averageVolume20: number;
  volumeRatio7d?: number;
  frequency?: number | null;
  averageLotsPerTrade?: number | null;
  brokerSignal?: BrokerSignal;
  brokerConfirmed?: boolean;
  topBuyer?: string | null;
  topSeller?: string | null;
  foreignNetValue?: number | null;
  error?: string;
}

function emptyScore(): ScoreBreakdown {
  return { aboveEMA125: 0, ema125Rising: 0, emaAlignment: 0, emaSlope: 0, higherHigh: 0, higherLow: 0, pullback: 0, structureHeld: 0, confirmation: 0, volume: 0 };
}

function scannerErrorResult(symbol: string, error: string): ScannerResult {
  return {
    symbol, score: 0, status: "INVALID", trend: "NONE", ema8: null, ema21: null,
    ema125: null, atr14: null, latestPivotHigh: null, previousPivotHigh: null,
    latestPivotLow: null, previousPivotLow: null, higherHigh: false, higherLow: false,
    pullbackDetected: false, pullbackLow: null, confirmationDetected: false,
    confirmationHigh: null, entryPrice: null, stopLoss: null, takeProfit: null,
    riskReward: null, scoreBreakdown: emptyScore(), proximityPct: Infinity,
    averageVolume20: 0, error,
  };
}

function analyzeSetup(candles5m: ScannerCandle[], candles15m: ScannerCandle[], symbol: string): ScannerResult {
  const base: ScannerResult = {
    symbol, score: 0, status: "NO_SETUP" as SetupStatus, trend: "NONE",
    ema8: null as number | null, ema21: null as number | null, ema125: null as number | null,
    atr14: null as number | null,
    latestPivotHigh: null as number | null, previousPivotHigh: null as number | null,
    latestPivotLow: null as number | null, previousPivotLow: null as number | null,
    higherHigh: false, higherLow: false, pullbackDetected: false,
    pullbackLow: null as number | null, confirmationDetected: false,
    confirmationHigh: null as number | null, entryPrice: null as number | null,
    stopLoss: null as number | null, takeProfit: null as number | null,
    riskReward: null as number | null, scoreBreakdown: emptyScore(),
    proximityPct: Infinity, averageVolume20: 0,
  };
  if (candles15m.length < 135 || candles5m.length < 135) return { ...base, status: "INVALID" as SetupStatus, error: "History candle tidak cukup" };

  const h = candles15m.at(-1)!;
  const h5 = candles15m.at(-6)!;
  const hp = candles15m.at(-2)!;
  const breakdown = emptyScore();
  const aboveEMA125 = h.close > h.ema125;
  const ema125Rising = h.ema125 > h5.ema125;
  const emaAlignment = h.ema8 > h.ema21;
  const ema8Rising = h.ema8 > hp.ema8;
  const ema21Rising = h.ema21 > hp.ema21;
  breakdown.aboveEMA125 = aboveEMA125 ? 10 : 0;
  breakdown.ema125Rising = ema125Rising ? 10 : 0;
  breakdown.emaAlignment = emaAlignment ? 10 : 0;
  breakdown.emaSlope = ema8Rising && ema21Rising ? 10 : 0;
  const preScreenPassed = aboveEMA125 && ema125Rising && emaAlignment && ema8Rising && ema21Rising && h.volume > 0;
  if (!preScreenPassed) {
    const score = Object.values(breakdown).reduce((sum, x) => sum + x, 0);
    return { ...base, ema8: h.ema8, ema21: h.ema21, ema125: h.ema125, atr14: h.atr14, score, scoreBreakdown: breakdown, averageVolume20: h.volumeSma20 ?? 0 };
  }

  const pivots = confirmedPivots(candles15m, 3);
  if (pivots.highs.length < 2 || pivots.lows.length < 2) {
    return { ...base, status: "BULLISH_TREND" as SetupStatus, trend: "BULLISH", ema8: h.ema8, ema21: h.ema21, ema125: h.ema125, atr14: h.atr14, score: 40, scoreBreakdown: breakdown, averageVolume20: h.volumeSma20 ?? 0 };
  }
  const latestHigh = pivots.highs.at(-1)!, previousHigh = pivots.highs.at(-2)!;
  const latestLow = pivots.lows.at(-1)!, previousLow = pivots.lows.at(-2)!;
  const higherHigh = latestHigh.price > previousHigh.price;
  const higherLow = latestLow.price > previousLow.price;
  breakdown.higherHigh = higherHigh ? 10 : 0;
  breakdown.higherLow = higherLow ? 15 : 0;
  if (!higherHigh || !higherLow) {
    const score = Object.values(breakdown).reduce((sum, x) => sum + x, 0);
    return { ...base, status: "NO_SETUP" as SetupStatus, trend: "BULLISH_FILTER_ONLY", ema8: h.ema8, ema21: h.ema21, ema125: h.ema125, atr14: h.atr14, latestPivotHigh: latestHigh.price, previousPivotHigh: previousHigh.price, latestPivotLow: latestLow.price, previousPivotLow: previousLow.price, higherHigh, higherLow, score, scoreBreakdown: breakdown, averageVolume20: h.volumeSma20 ?? 0 };
  }

  const current = candles5m.at(-1)!;
  const scanStart = Math.max(130, candles5m.length - 60);
  let pullbackIndex: number | null = null, pullbackLow: number | null = null;
  let confirmationIndex: number | null = null, confirmationHigh: number | null = null;
  let invalid = false;
  for (let i = scanStart; i < candles5m.length; i++) {
    const c = candles5m[i];
    const atr = c.atr14;
    if (!atr) continue;
    const setupExisted = pullbackIndex != null || confirmationIndex != null;
    if (setupExisted && (c.close < latestLow.price || c.ema8 < c.ema21 || c.close < c.ema125)) {
      invalid = true; break;
    }
    const validPullback = c.low <= c.ema8 && c.low >= c.ema21 - 0.25 * atr && c.low > latestLow.price;
    if (validPullback && confirmationIndex == null) {
      pullbackIndex ??= i;
      pullbackLow = pullbackLow == null ? c.low : Math.min(pullbackLow, c.low);
    }
    if (pullbackIndex != null && i > pullbackIndex && confirmationIndex == null) {
      const range = c.high - c.low;
      const body = c.close - c.open;
      const confirmation = range > 0 && c.close > c.open && body / range >= 0.5 &&
        (c.close - c.low) / range >= 0.7 && c.close > c.ema8;
      if (confirmation) {
        confirmationIndex = i;
        confirmationHigh = c.high;
      }
    }
  }

  const pullbackDetected = pullbackIndex != null;
  const confirmationDetected = confirmationIndex != null && confirmationHigh != null;
  const structureHeld = pullbackDetected && !invalid && pullbackLow! > latestLow.price;
  const volumeAvailable = current.volumeSma20 != null;
  const volumeConfirmed = confirmationIndex != null &&
    candles5m[confirmationIndex].volumeSma20 != null &&
    candles5m[confirmationIndex].volume > candles5m[confirmationIndex].volumeSma20!;
  breakdown.pullback = pullbackDetected ? 15 : 0;
  breakdown.structureHeld = structureHeld ? 10 : 0;
  breakdown.confirmation = confirmationDetected ? 5 : 0;
  breakdown.volume = volumeConfirmed ? 5 : 0;
  let score = Object.values(breakdown).reduce((sum, x) => sum + x, 0);
  if (!volumeAvailable) score = Math.round(score / 95 * 100);

  let status: SetupStatus;
  if (invalid) status = "INVALID";
  else if (confirmationDetected) {
    const broken = candles5m.slice(confirmationIndex! + 1).some((c) => c.high > confirmationHigh!);
    status = broken ? "READY_BUY" : "WAIT_BREAKOUT";
  } else if (pullbackDetected) {
    const currentlyPullingBack = current.atr14 != null &&
      current.low <= current.ema8 &&
      current.low >= current.ema21 - 0.25 * current.atr14 &&
      current.low > latestLow.price;
    status = currentlyPullingBack ? "PULLBACK" : "WAIT_CONFIRMATION";
  }
  else status = current.close > current.ema8 + 0.5 * (current.atr14 ?? 0) ? "WAIT_PULLBACK" : "BULLISH_TREND";

  const entryPrice = confirmationHigh == null ? null : roundToIdxTick(confirmationHigh + idxTickSize(confirmationHigh), "up");
  let stopLoss = pullbackLow == null || current.atr14 == null ? null : roundToIdxTick(pullbackLow - 0.1 * current.atr14, "down");
  if (entryPrice != null && stopLoss != null && stopLoss >= entryPrice) stopLoss = roundToIdxTick(entryPrice - idxTickSize(entryPrice), "down");
  const risk = entryPrice != null && stopLoss != null ? entryPrice - stopLoss : null;
  const takeProfit = risk != null && risk > 0 ? roundToIdxTick(entryPrice! + risk, "up") : null;
  const proximityPct = confirmationHigh != null ? Math.max(confirmationHigh - current.close, 0) / current.close * 100 : Math.abs(current.low - current.ema8) / current.close * 100;

  return {
    ...base, symbol, score, status, trend: "BULLISH", ema8: current.ema8, ema21: current.ema21,
    ema125: current.ema125, atr14: current.atr14, latestPivotHigh: latestHigh.price,
    previousPivotHigh: previousHigh.price, latestPivotLow: latestLow.price,
    previousPivotLow: previousLow.price, higherHigh, higherLow, pullbackDetected,
    pullbackLow, confirmationDetected, confirmationHigh, entryPrice, stopLoss,
    takeProfit, riskReward: risk != null && risk > 0 ? 1 : null, scoreBreakdown: breakdown,
    proximityPct, averageVolume20: current.volumeSma20 ?? 0,
  };
}

function formatScannerReport(results: ScannerResult[], requested: number, shortlisted: number): string {
  const valid = results.filter((r) => !r.error);
  const actionable = valid.filter((r) => STATUS_PRIORITY[r.status] <= STATUS_PRIORITY.WAIT_PULLBACK);
  const rows = valid.slice(0, 10).map((r, i) => {
    const levels = r.entryPrice == null ? "" : ` | E ${rupiahPrice(r.entryPrice)} SL ${rupiahPrice(r.stopLoss)} TP ${rupiahPrice(r.takeProfit)}`;
    const volume = r.volumeRatio7d == null ? "" : ` | Vol ${r.volumeRatio7d.toFixed(2)}×`;
    const frequency = r.frequency == null ? "" : ` | F ${compactNumber(r.frequency)}`;
    const broker = r.brokerSignal == null ? "" : ` | ${brokerLabel(r.brokerSignal)}`;
    return `${i + 1}. **${r.symbol}** — ${r.status} | ${r.score}/100${volume}${frequency}${broker}${levels}`;
  });
  return [
    `🔎 **EMA STRUCTURE SCANNER — 15m + 5m**`,
    `Universe: ${requested} | Top volume: ${shortlisted} | Dianalisis: ${valid.length} | Setup: ${actionable.length}`, "",
    ...(rows.length ? rows : ["Tidak ada data yang berhasil dianalisis."]), "",
    "15m: EMA125 rising + EMA8/21 rising + HH/HL.",
    "5m: pullback → confirmation → break confirmation high.",
    "Broker: Top 3 buyer/seller + foreign net value (konfirmasi tambahan).",
    "Pivot Length 3 hanya memakai pivot yang sudah confirmed. Candle berjalan tidak digunakan.",
    `Universe ticker diperbarui: ${IDX_SYMBOLS_UPDATED_AT}.`,
    "_Scanner teknikal bukan jaminan hasil._",
  ].join("\n").slice(0, 1950);
}

function brokerLabel(signal: BrokerSignal): string {
  if (signal === "ACCUMULATION") return "BRK ACC";
  if (signal === "DISTRIBUTION") return "BRK DIST";
  if (signal === "NEUTRAL") return "BRK NTRL";
  return "BRK N/A";
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function latestDailyCandleStatus(unix: number) {
  const nowParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => nowParts.find((p) => p.type === type)?.value || "";
  const today = `${get("year")}-${get("month")}-${get("day")}`;
  const hour = Number(get("hour"));
  const barDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(unix * 1000));
  return barDate === today && hour < 16 ? "berjalan" : "selesai";
}

function uniqueLevels(values: number[], close: number) {
  return values.filter(Number.isFinite).sort((a, b) => b - a).filter((v, i, arr) =>
    i === 0 || Math.abs(v - arr[i - 1]) / close > 0.012
  );
}

function analyzeDaily(bars) {
  const i = bars.length - 1, b = bars[i], p = bars[i - 1];
  const cloudTop = Math.max(b.spanA ?? -Infinity, b.spanB ?? -Infinity);
  const cloudBottom = Math.min(b.spanA ?? Infinity, b.spanB ?? Infinity);
  const high20 = rollingMax(bars, i - 1, 20, "high");
  const high50 = rollingMax(bars, i - 1, 50, "high");
  const low20 = rollingMin(bars, i, 20, "low");
  const low50 = rollingMin(bars, i, 50, "low");
  const atr = b.atr || b.close * 0.03;
  const relativeVolume = b.volSma20 ? b.volume / b.volSma20 : 0;

  let trendScore = 0;
  if (b.close > b.ema20) trendScore++;
  if (b.ema20 > b.ema50) trendScore++;
  if (b.ema50 > b.ema200) trendScore++;
  if (b.close > cloudTop) trendScore++;
  if (b.tenkan > b.kijun) trendScore++;
  const trend = trendScore >= 4 ? "BULLISH" : trendScore <= 1 ? "BEARISH" : "NETRAL";

  const supports = uniqueLevels(
    [b.ema20, b.ema50, b.kijun, cloudTop, cloudBottom, low20, low50].filter((x) => x <= b.close),
    b.close,
  );
  const resistances = uniqueLevels(
    [high20, high50].filter((x) => x > b.close * 1.002),
    b.close,
  ).sort((a, c) => a - c);
  if (!resistances.length) resistances.push(b.close + atr, b.close + 2 * atr);
  const support1 = supports[0] ?? b.close - atr;
  const support2 = supports[1] ?? b.close - 2 * atr;
  const resistance1 = resistances[0];
  const resistance2 = resistances[1] ?? resistance1 + atr;
  const stretched = b.close - b.ema20 > 1.5 * atr || b.rsi >= 70;
  const nearSupport = b.close - support1 <= 0.65 * atr;
  const nearResistance = resistance1 - b.close <= 0.55 * atr;
  const bullishCandle = b.close > b.open && b.close > p.close;
  const breakout = b.close > high20 && relativeVolume >= 1.2;

  let status, reason, entryLow, entryHigh, stop, tp1, tp2;
  if (trend === "BEARISH") {
    status = "NO TRADE"; reason = "Struktur Daily masih bearish; tunggu reclaim EMA20 dan perbaikan tren.";
  } else if (breakout && trend === "BULLISH") {
    status = "ENTRY BREAKOUT AKTIF"; reason = "Daily close menembus resistance dengan volume ≥1,2× rata-rata.";
    entryLow = high20; entryHigh = b.close; stop = Math.max(support1, entryLow - 1.3 * atr);
  } else if (nearSupport && bullishCandle && trend === "BULLISH" && relativeVolume >= 0.9) {
    status = "ENTRY PULLBACK AKTIF"; reason = "Harga berada dekat support dan menghasilkan konfirmasi candle bullish.";
    entryLow = support1; entryHigh = b.close; stop = Math.min(support2, support1 - 1.1 * atr);
  } else if (stretched || nearResistance) {
    status = nearResistance ? "TUNGGU BREAKOUT" : "TUNGGU PULLBACK";
    reason = nearResistance ? "Harga dekat resistance; jangan mengejar sebelum Daily close dan volume mengonfirmasi." : "Harga terlalu jauh dari EMA20/RSI tinggi; risk-reward entry sekarang kurang menarik.";
    entryLow = nearResistance ? resistance1 : support1; entryHigh = nearResistance ? resistance1 + 0.25 * atr : Math.min(b.ema20, b.close);
    stop = nearResistance ? Math.max(support1, resistance1 - 1.3 * atr) : Math.min(support2, support1 - atr);
  } else {
    status = "TUNGGU PULLBACK"; reason = "Tren belum memberikan trigger entry dengan risk-reward yang cukup.";
    entryLow = support1; entryHigh = Math.min(b.ema20, b.close); stop = Math.min(support2, support1 - atr);
  }
  if (entryLow != null) {
    const referenceEntry = Math.max(entryLow, entryHigh);
    const risk = Math.max(referenceEntry - stop, atr * 0.8);
    tp1 = Math.max(resistance1, referenceEntry + risk);
    tp2 = Math.max(resistance2, referenceEntry + 2 * risk);
  }
  return {
    trend, trendScore, relativeVolume, support1, support2, resistance1, resistance2,
    status, reason, entryLow, entryHigh, stop, tp1, tp2,
    rsi: b.rsi, macdHist: b.macdHist, macdImproving: b.macdHist > p.macdHist,
    aboveCloud: b.close > cloudTop, atrPct: atr / b.close * 100,
  };
}

function formatTechnicalReport(ticker, bars, a, ignoredCandleStatus) {
  const b = bars.at(-1);
  const macd = a.macdHist > 0 ? (a.macdImproving ? "bullish menguat" : "bullish melemah") : (a.macdImproving ? "bearish membaik" : "bearish melemah");
  const rsiState = a.rsi >= 70 ? "overbought" : a.rsi <= 30 ? "oversold" : a.rsi >= 55 ? "bullish" : a.rsi <= 45 ? "bearish" : "netral";
  const entryMin = a.entryLow == null ? null : Math.min(a.entryLow, a.entryHigh);
  const entryMax = a.entryLow == null ? null : Math.max(a.entryLow, a.entryHigh);
  const entry = entryMin == null ? "Entry: –" : `Area entry: **${rupiahPrice(entryMin)}–${rupiahPrice(entryMax)}**\nSL: **${rupiahPrice(a.stop)}** | TP1: **${rupiahPrice(a.tp1)}** | TP2: **${rupiahPrice(a.tp2)}**`;
  return [
    `📈 **TECHNICAL ${ticker} — DAILY**`,
    `Data: ${wib(b.time)} | Close: **${rupiahPrice(b.close)}**`,
    ignoredCandleStatus === "berjalan" ? "_Candle hari ini belum selesai dan dikeluarkan dari analisis._" : "_Menggunakan candle Daily yang sudah selesai._", "",
    `**TREND: ${a.trend} (${a.trendScore}/5)**`,
    `EMA20 ${rupiahPrice(b.ema20)} | EMA50 ${rupiahPrice(b.ema50)} | EMA200 ${rupiahPrice(b.ema200)}`,
    `Ichimoku: ${a.aboveCloud ? "harga di atas Kumo" : "harga belum di atas Kumo"}`, "",
    `**MOMENTUM**`,
    `RSI14: ${a.rsi.toFixed(1)} — ${rsiState}`,
    `MACD histogram: ${a.macdHist.toFixed(2)} — ${macd}`,
    `Volume: ${a.relativeVolume.toFixed(2)}× rata-rata 20 hari | ATR: ${a.atrPct.toFixed(2)}%`, "",
    `**LEVEL**`,
    `Support: **${rupiahPrice(a.support1)}** / **${rupiahPrice(a.support2)}**`,
    `Resistance: **${rupiahPrice(a.resistance1)}** / **${rupiahPrice(a.resistance2)}**`, "",
    `🎯 **${a.status}**`, a.reason, entry, "",
    "Konfirmasi entry menggunakan candle Daily yang sudah close. _Analisis teknikal bukan jaminan hasil._",
  ].join("\n").slice(0, 1950);
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
  let ema9 = null, ema12 = null, ema20 = null, ema21 = null, ema26 = null;
  let ema50 = null, ema200 = null, macdSignal = null;
  let avgGain = null, avgLoss = null, atr = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    ema9 = ema9 == null ? b.close : b.close * 0.2 + ema9 * 0.8;
    ema12 = ema12 == null ? b.close : b.close * (2 / 13) + ema12 * (11 / 13);
    ema20 = ema20 == null ? b.close : b.close * (2 / 21) + ema20 * (19 / 21);
    ema21 = ema21 == null ? b.close : b.close * (2 / 22) + ema21 * (20 / 22);
    ema26 = ema26 == null ? b.close : b.close * (2 / 27) + ema26 * (25 / 27);
    ema50 = ema50 == null ? b.close : b.close * (2 / 51) + ema50 * (49 / 51);
    ema200 = ema200 == null ? b.close : b.close * (2 / 201) + ema200 * (199 / 201);
    b.ema9 = ema9; b.ema20 = ema20; b.ema21 = ema21; b.ema50 = ema50; b.ema200 = ema200;
    b.macd = ema12 - ema26;
    macdSignal = macdSignal == null ? b.macd : b.macd * 0.2 + macdSignal * 0.8;
    b.macdSignal = macdSignal;
    b.macdHist = b.macd - macdSignal;
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
