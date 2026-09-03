# Discord IDX Backtester — Deno Deploy

## Deploy

1. Upload `main.ts` and `deno.json` to the root of the GitHub repository.
2. In Deno Deploy choose **No Preset**, **Dynamic**, and `main.ts` as the entrypoint.
3. Add Production environment variables `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`, and a temporary random `REGISTER_SECRET`.
4. Deploy the default branch.
5. Keep the existing Deno production URL as Discord's Interactions Endpoint URL.

The package provides `/backtest` for intraday testing, `/technical` for Daily technical analysis, and `/scan` for the EMA/market-structure setup scanner.

## Register the command globally

After deploying, open this URL once, replacing the key with the exact `REGISTER_SECRET` value:

```text
https://YOUR-DENO-APP.deno.net/register-global?key=YOUR_REGISTER_SECRET
```

When `success: true` appears, confirm that `/backtest`, `/technical`, and `/scan` are returned. Remove `REGISTER_SECRET` from Deno Deploy and redeploy. The registration route will then return `401` and cannot be reused. The global commands become available in every server where the Discord app is installed; an existing guild command does not need to be deleted.

## Usage

```text
/backtest ticker:DMAS
/backtest ticker:BEST fee_beli:0.15 fee_jual:0.25 slippage:0.10
/technical ticker:DMAS
/scan
/scan symbols:DMAS,BBCA,IMJS
```

`/scan` without an argument uses the ticker universe stored in `idx_symbols.ts`. It first downloads one month of Daily data, calculates today's volume divided by the mean of the previous seven trading days, keeps stocks with a ratio of at least `2.0`, and selects the top ten ratios. Only those ten stocks proceed to frequency enrichment, broker-summary enrichment, and the full setup scanner. The optional `symbols` argument remains available for smaller tests.

Frequency is read from Kontan's public quote page. Broker buyer/seller value and foreign net value are read from IPOTNEWS's public broker-summary table. Both enrichments are best-effort: a source failure is shown as unavailable and never suppresses the EMA result. `BRK ACC`, `BRK NTRL`, and `BRK DIST` are approximate confirmations based on the top-three displayed buyers versus sellers and the displayed foreign net value; they are not exchange-certified trade recommendations.

For the top ten, the scanner downloads native Yahoo Finance 15-minute candles for trend/confirmed pivots and native 5-minute candles for pullback, confirmation, breakout entry, stop loss, and take profit. It does not resample scanner candles. The bundled universe contains 951 codes from a public snapshot updated on 2025-02-23; update `idx_symbols.ts` when the official IDX universe changes.

`/backtest` keeps its existing behavior: it downloads Yahoo Finance 5-minute bars for 60 days, resamples that data to 15 minutes, tests seven strategies, applies fees and slippage, checks the final 30% as out-of-sample data, and posts the ranking plus current entry guidance to Discord.
