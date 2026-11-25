// risk.ts — position sizing and exposure guards for Paper Pump Rider.
//
// The launch filter in strategy.ts decides *which* coin to ride; this module decides
// *how much* to risk on it and *whether* the book can take another position right now.
// It owns exactly two pieces of state — the realised-PnL peak (for drawdown) and a
// per-mint loss cooldown — and everything else is passed in per call, so the book can
// never drift out of sync with the strategy's own ride/probe maps. Pure arithmetic
// only: no clock, no randomness, no I/O, no environment reads, so the bot stays
// deterministic.

/** Tuning knobs for the risk book. All amounts in SOL, all slots in replay slots. */
export interface RiskParams {
  /** Base stake per main position, in SOL. */
  baseStakeSol: number;
  /** Smallest stake the sizer will ever return (never below the harness minimum). */
  minStakeSol: number;
  /** Most SOL at cost across all open positions at once. */
  maxExposureSol: number;
  /** Most main positions open at once. */
  maxPositions: number;
  /** Realised drawdown (SOL) at which the stake starts shrinking below base. */
  drawdownKneeSol: number;
  /** Realised drawdown (SOL) at which the stake reaches its floor factor. */
  drawdownCapSol: number;
  /** Smallest stake multiplier, reached at drawdownCapSol. */
  minStakeFactor: number;
  /** Extra stake shrink per open position beyond the first (concentration brake). */
  perPositionShrink: number;
  /** Slots to wait before re-entering a coin whose last exit lost money. */
  lossCooldownSlots: number;
}

export const DEFAULT_RISK_PARAMS: RiskParams = {
  baseStakeSol: 0.15,
  minStakeSol: 0.01,
  maxExposureSol: 1,
  maxPositions: 5,
  drawdownKneeSol: 0.05,
  drawdownCapSol: 0.3,
  minStakeFactor: 0.6,
  perPositionShrink: 0.04,
  lossCooldownSlots: 200,
};

/** The risk book: realised-PnL peak for drawdown sizing plus loss cooldowns. */
export class RiskBook {
  private readonly p: RiskParams;
  /** Slot until which a mint may not be re-entered, set after a losing exit. */
  private readonly coolingUntil = new Map<string, number>();
  /** Best realised PnL (SOL) seen so far; drawdown is peak minus current. */
  private realisedPeak = 0;
  private realised = 0;

  constructor(p: RiskParams) {
    this.p = p;
  }

  /** Current realised drawdown in SOL (0 while the book sits at its peak). */
  get drawdownSol(): number {
    return Math.max(0, this.realisedPeak - this.realised);
  }

  /** Stake multiplier from drawdown alone: 1 below the knee, shrinking linearly to
   *  minStakeFactor at the cap, flat beyond it. A misconfigured cap at or below the
   *  knee can never divide by zero: the span is floored at a hair above zero. */
  drawdownFactor(): number {
    const dd = this.drawdownSol;
    if (dd <= this.p.drawdownKneeSol) return 1;
    if (dd >= this.p.drawdownCapSol) return this.p.minStakeFactor;
    const span = Math.max(1e-9, this.p.drawdownCapSol - this.p.drawdownKneeSol);
    const t = (dd - this.p.drawdownKneeSol) / span;
    return 1 - t * (1 - this.p.minStakeFactor);
  }

  /** Stake for the next main entry, in SOL: base stake shrunk by the drawdown factor
   *  and by a small concentration brake as more positions open at once. Never below
   *  minStakeSol, so a sized entry always stays a legal order. */
  stakeFor(openCount: number): number {
    const concentration = 1 - this.p.perPositionShrink * Math.max(0, openCount - 1);
    const stake = this.p.baseStakeSol * this.drawdownFactor() * concentration;
    return Math.max(this.p.minStakeSol, stake);
  }

  /** Is this mint still cooling down after a losing exit? Expired entries are pruned
   *  on sight so the cooldown map stays bounded over a long replay. */
  isCooling(mint: string, now: number): boolean {
    const until = this.coolingUntil.get(mint);
    if (until === undefined) return false;
    if (now >= until) {
      this.coolingUntil.delete(mint);
      return false;
    }
    return true;
  }

  /** May this mint be opened now for `amount` SOL, given the book's current shape?
   *  Rejects a cooling mint, a full book, an exposure breach, or a dust-sized amount. */
  canOpen(mint: string, now: number, amount: number, openCount: number, exposureSol: number): boolean {
    if (amount < this.p.minStakeSol) return false;
    if (this.isCooling(mint, now)) return false;
    if (openCount >= this.p.maxPositions) return false;
    if (exposureSol + amount > this.p.maxExposureSol) return false;
    return true;
  }

  /** Record an exit once its sell order goes out. `pnlSol` is the exit value minus
   *  cost estimated at decision time (the sell fills at roughly that value); the
   *  book treats it as realised, which is conservative when the fill slips. A losing
   *  exit starts the mint's cooldown so the bot does not chase the same coin twice.
   *  A non-finite PnL estimate (a bad mark) is ignored rather than poisoning the
   *  realised total, and a cooldown is only ever extended, never shortened, by a
   *  second losing exit inside the window. */
  noteExit(mint: string, pnlSol: number, now: number): void {
    if (!Number.isFinite(pnlSol)) return;
    this.realised += pnlSol;
    if (this.realised > this.realisedPeak) this.realisedPeak = this.realised;
    if (pnlSol < 0) {
      const until = now + this.p.lossCooldownSlots;
      const prev = this.coolingUntil.get(mint);
      if (prev === undefined || until > prev) this.coolingUntil.set(mint, until);
    }
  }
}
