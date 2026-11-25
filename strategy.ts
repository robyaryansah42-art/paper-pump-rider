// Paper Pump Rider — a paper-money bot for the agent-fun pump.fun replay (agent-fun/replay/v2).
//
// Idea (my own design): buy a coin in its very first slots, but only when its opening tape
// looks like a real crowd arriving — not a bundle — and get out fast either way.
//
//   Entry ("launch rider"): a curve at most 1 slot old whose opening tape shows the creator
//   bought a modest amount (skin in the game, but not a whale bundle and not more than half of
//   all buys), at least 4 distinct non-creator wallets already bought, almost no selling yet,
//   the creator has not sold, the price has not already run away, and the most recent trade is
//   a buy. One fixed small stake per coin, one entry per coin ever, capped by the harness's 1%
//   of real reserve per reply.
//
//   Exits: a fixed take-profit (+65%), a fixed stop-loss (-12%), a maximum hold (1000 slots),
//   and an instant exit the moment the creator sells. A curve that completes is closed by the
//   replay itself.
//
//   Guardrail pacing: the run must clear at least 20 coins with round trips of at least 0.01
//   SOL, but a strict launch filter only finds ~8 coins in 6 hours, so when the bot's own
//   fills or coins lag a pace set in block time it opens tiny probe round trips (0.01 SOL, the
//   smallest qualifying size) on liquid curves whose tape still shows net buying — buy a
//   little, sell it as soon as the buy lands — until it is back on pace.
//
//   Risk book (risk.ts): the stake is not fixed — it shrinks while realised drawdown grows
//   and while many positions are open at once; total exposure and concurrent positions are
//   capped; and a coin whose last exit lost money is not re-entered for 200 slots.
//
// What was tried and left out: buying older "continuation" curves (their tape looks alive but
// the entries buy tops — it lost ~0.33 SOL on the dev window), a trailing stop (it never fired
// before take-profit / stop / max-hold did), and re-entering a coin after an exit (one entry
// per coin keeps the book clean). Parameters were picked from flat regions of sweeps over the
// dev window's four 6-hour slices, not from a single best cell.
//
// Deterministic by construction: no clock, no randomness, no I/O, no environment reads.
// Iteration is only over insertion-ordered maps fed by the batch stream, and block_time (which
// comes from the replay data, not the wall clock) is used only for pacing.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';
import { RiskBook, type RiskParams } from './risk.ts';

export interface RiderParams {
  /** SOL staked in one position (single buy, no adds). */
  stakeSol: number;
  /** Smallest buy worth sending (a tx costs 105k lamports). */
  minBuySol: number;
  /** Slippage allowed on buys in bps; sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when the position's close value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Exit when the position's close value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Most SOL at cost across all open positions at once. */
  maxExposureSol: number;
  /** Most main (non-probe) positions open at once. */
  maxMain: number;

  /** Youngest age (slots since CreateEvent) at which a launch may be bought. */
  launchMinAge: number;
  /** Oldest age (slots) at which a launch may still be bought. */
  launchMaxAge: number;
  /** Creator's own buys in the launch window, in SOL: [min, max]. */
  launchDevBuyMin: number;
  launchDevBuyMax: number;
  /** Distinct non-creator buyers seen before entry: [min, max]. */
  launchBuyersMin: number;
  launchBuyersMax: number;
  /** Total non-creator buy SOL in the launch window, at least. */
  launchMinBuySol: number;
  /** Creator's buys as a share of all buys in the launch window, at most. */
  launchMaxDevShare: number;
  /** Sell SOL / buy SOL over the launch window, at most. */
  launchMaxSellRatio: number;
  /** Price now over the create price: [min, max]. */
  launchRunupMin: number;
  launchRunupMax: number;
  /** Real SOL reserve at entry: [min, max]. */
  launchRqMin: number;
  launchRqMax: number;
  /** The most recent trade must be a buy. */
  launchLastMustBeBuy: boolean;
  /** Exit a launch ride as soon as the creator sells. */
  launchExitOnDevSell: boolean;

  /** Guardrail pacing: target coins / fills over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** Probe buy size in SOL (0.01 is the smallest qualifying round trip). */
  probeSol: number;
  maxProbes: number;
  /** Probe only a curve whose net SOL flow over this many slots is at least probeMinFlow. */
  probeFlowWindow: number;
  probeMinFlow: number;

  /** Risk book (risk.ts): realised drawdown at which the stake starts shrinking. */
  riskDrawdownKneeSol: number;
  /** Risk book: realised drawdown at which the stake reaches its floor factor. */
  riskDrawdownCapSol: number;
  /** Risk book: smallest stake multiplier, reached at the drawdown cap. */
  riskMinStakeFactor: number;
  /** Risk book: extra stake shrink per open position beyond the first. */
  riskPerPositionShrink: number;
  /** Risk book: slots to wait before re-entering a coin whose last exit lost money. */
  riskLossCooldownSlots: number;
}

// Settings traded with: picked from flat regions of sweeps over the dev window's four 6-hour
// slices (mean +0.027 SOL per slice, 3 of 4 slices positive, 22-23 coins each, max drawdown
// under 1%) and over the full 24h dev window (+0.15 SOL, 58 coins, drawdown 0.9%).
export const DEFAULT_PARAMS: RiderParams = {
  stakeSol: 0.15,
  minBuySol: 0.01,
  buySlipBps: 2000,
  takeProfit: 0.65,
  stopLoss: 0.12,
  maxHold: 1000,
  maxExposureSol: 1,
  maxMain: 5,

  launchMinAge: 1,
  launchMaxAge: 1,
  launchDevBuyMin: 0.01,
  launchDevBuyMax: 2.5,
  launchBuyersMin: 4,
  launchBuyersMax: 8,
  launchMinBuySol: 0,
  launchMaxDevShare: 0.5,
  launchMaxSellRatio: 0.2,
  launchRunupMin: 0,
  launchRunupMax: 0.8,
  launchRqMin: 0.3,
  launchRqMax: 30,
  launchLastMustBeBuy: true,
  launchExitOnDevSell: true,

  targetCoins: 22,
  targetFills: 44,
  paceSecs: 21_600,
  probeSol: 0.01,
  maxProbes: 1,
  probeFlowWindow: 20,
  probeMinFlow: 0.02,

  riskDrawdownKneeSol: 0.05,
  riskDrawdownCapSol: 0.3,
  riskMinStakeFactor: 0.6,
  riskPerPositionShrink: 0.04,
  riskLossCooldownSlots: 200,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CurveTape {
  created: number | null;
  creator: string | null;
  createPrice: number;
  trades: TapeTrade[];
  entered: boolean;
}

interface Ride {
  opened: number;
  invested: number;
  exiting: boolean;
}

export function createStrategy(p: RiderParams = DEFAULT_PARAMS): Bot {
  const riskParams: RiskParams = {
    baseStakeSol: p.stakeSol,
    minStakeSol: p.minBuySol,
    maxExposureSol: p.maxExposureSol,
    maxPositions: p.maxMain,
    drawdownKneeSol: p.riskDrawdownKneeSol,
    drawdownCapSol: p.riskDrawdownCapSol,
    minStakeFactor: p.riskMinStakeFactor,
    perPositionShrink: p.riskPerPositionShrink,
    lossCooldownSlots: p.riskLossCooldownSlots,
  };
  const risk = new RiskBook(riskParams);
  const tapes = new Map<Pubkey, CurveTape>();
  const rides = new Map<Pubkey, Ride>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = p.probeFlowWindow + 10;

  const tapeOf = (mint: Pubkey): CurveTape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, createPrice: 0, trades: [], entered: false };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots of a tape. */
  const flow = (t: CurveTape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Is this fresh curve's opening tape organic enough to ride? */
  const launchSignal = (t: CurveTape, now: number, rqSol: number, price: number): boolean => {
    if (t.created === null || t.creator === null) return false;
    const age = now - t.created;
    if (age < p.launchMinAge || age > p.launchMaxAge) return false;
    if (rqSol < p.launchRqMin || rqSol > p.launchRqMax) return false;
    if (t.createPrice <= 0) return false;
    const runup = price / t.createPrice - 1;
    if (runup < p.launchRunupMin || runup > p.launchRunupMax) return false;
    let devBuy = 0;
    let devSold = false;
    let buySol = 0;
    let sellSol = 0;
    const buyers = new Set<string>();
    let lastBuy = false;
    for (const tr of t.trades) {
      if (tr.user === t.creator) {
        if (tr.buy) devBuy += tr.sol;
        else devSold = true;
      } else if (tr.buy) {
        buySol += tr.sol;
        buyers.add(tr.user);
      } else {
        sellSol += tr.sol;
      }
      lastBuy = tr.buy;
    }
    if (devSold) return false;
    if (devBuy < p.launchDevBuyMin || devBuy > p.launchDevBuyMax) return false;
    if (buyers.size < p.launchBuyersMin || buyers.size > p.launchBuyersMax) return false;
    if (buySol < p.launchMinBuySol) return false;
    if (devBuy > p.launchMaxDevShare * (devBuy + buySol)) return false;
    if (buySol <= 0 || sellSol > p.launchMaxSellRatio * buySol) return false;
    if (p.launchLastMustBeBuy && !lastBuy) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const creatorSold = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
          if (!e.is_buy && t.creator !== null && e.user === t.creator) creatorSold.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, r] of rides) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) rides.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        let exit = r.exiting;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && now - r.opened > p.maxHold) exit = true;
        if (!exit && p.launchExitOnDevSell && creatorSold.has(mint)) exit = true;
        if (!exit) continue;
        r.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        // Book the exit in the risk book: a losing exit starts this mint's cooldown
        // and feeds the realised drawdown that sizes the next entries.
        risk.noteExit(mint, value - cost, now);
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - rides.size;
      let exposure = 0;
      for (const [mint, r] of rides) {
        exposure += Math.max(r.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0 || mainLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || rides.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.entered) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!launchSignal(t, now, rqSol, price)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        // Risk-sized stake: the base stake shrunk while the book is in drawdown and
        // while many positions are already open; the book also enforces the exposure
        // cap, the concurrent-position cap, and the post-loss cooldown for this mint.
        const stake = risk.stakeFor(rides.size);
        let amount = Math.min(capSol, stake, p.maxExposureSol - exposure);
        if (!risk.canOpen(mint, now, amount, rides.size, exposure)) continue;
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        rides.set(mint, { opened: now, invested: amount, exiting: false });
        t.entered = true;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (rides.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            // Never probe a coin the risk book is cooling down after a losing exit.
            if (risk.isCooling(mint, now)) continue;
            const t = tapes.get(mint);
            if (t !== undefined) {
              if (flow(t, now, p.probeFlowWindow) < p.probeMinFlow) continue;
              const last = t.trades[t.trades.length - 1];
              if (last === undefined || !last.buy) continue;
            }
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
