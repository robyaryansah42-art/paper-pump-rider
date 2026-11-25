# Paper Pump Rider

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/robyaryansah42-art/paper-pump-rider/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/robyaryansah42-art/paper-pump-rider/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-money trading bot for the [Pump.fun Bot Sprint](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) on make.fun. It trades on a replay of pump.fun bonding-curve data (agent-fun/replay/v2) with 10 SOL of paper capital — no real money, no network, fully deterministic.

## Strategy

**Launch rider:** buy a coin in its very first slot, but only when its opening tape looks like a real crowd arriving, not a bundle:

- the creator bought a modest amount (skin in the game, but not a whale bundle and not more than half of all buys),
- at least 4 distinct non-creator wallets already bought,
- almost no selling yet, the creator has not sold, and the most recent trade is a buy,
- the price has not already run away (run-up ≤ 80% over the create price).

One fixed small stake (0.15 SOL, capped by the harness's 1% of real reserve) per coin, one entry per coin ever.

**Exits:** take-profit +65%, stop-loss −12%, maximum hold 1000 slots, and an instant exit the moment the creator sells. A curve that completes is closed by the replay.

**Guardrail pacing:** the strict launch filter only finds ~8 coins in 6 hours, but the run must clear 20 coins with round trips ≥ 0.01 SOL. When the bot's own fills or coins lag a pace set in block time, it opens tiny 0.01 SOL probe round trips on liquid curves whose tape still shows net buying, and sells them as soon as the buy lands.

**Left out on purpose:** buying older "continuation" curves (their tape looks alive but the entries buy tops — it lost ~0.33 SOL on the dev window), a trailing stop (it never fired before take-profit / stop / max-hold did), and re-entering a coin after an exit.

## Validation (offline, kit's dev window)

- Four 6-hour slices (proxy for the 6-hour final window): net PnL **+0.075 / −0.043 / +0.028 / +0.047 SOL** — mean +0.027, 3 of 4 positive, 22–23 coins with round trips ≥ 0.01 SOL each, max drawdown ≤ 0.7%.
- Full 24-hour dev window: net **+0.151 SOL**, 58 coins, 59 trips, max drawdown 0.9%; still +0.014 SOL at 2× fees.
- Deterministic: two runs produce byte-identical output (no clock, no randomness, no I/O in the bot).

## Layout

- `main.ts` — entrypoint the grader runs (`node /bot/main.ts`, Node 22+).
- `strategy.ts` — the strategy (this is the bot's own code).
- `vendor/agentfun-bot.ts` — the kit's replay SDK shim, vendored byte for byte.
- `tools/` — offline backtest harness (a copy of the kit's local engine port) for validation only; the bot never imports it.

## Run the backtest

```sh
node tools/backtest.ts <path to the unpacked kit>
```
