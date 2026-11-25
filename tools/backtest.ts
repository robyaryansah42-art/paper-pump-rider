// Offline backtest of strategy.ts on the kit's dev window with the local engine port.
//   node tools/backtest.ts <kit dir> ['{"takeProfit":0.3}']
import { createStrategy, DEFAULT_PARAMS, type RiderParams } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/backtest.ts <kit dir> [params json]');
  process.exit(2);
}
const overrides = process.argv[3] !== undefined && process.argv[3].startsWith('{') ? (JSON.parse(process.argv[3]) as Partial<RiderParams>) : {};
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', ds.sha256));
const params = { ...DEFAULT_PARAMS, ...overrides };
const r = simulate(ds, hello, createStrategy(params));
const sol = (x: bigint) => (Number(x) / 1e9).toFixed(6);
const trips = r.trips.filter((t) => t.pnl !== 0n);
const good = trips.filter((t) => t.pnl >= 10_000_000n);
const rt = trips.filter((t) => t.buy >= 10_000_000n);
const rtCoins = new Set(rt.map((t) => t.mint)).size;
console.log(`net ${sol(r.netPnl)} SOL  fills ${r.fills}  coins ${r.mints}  trips ${trips.length}  wins ${trips.filter((t) => t.pnl > 0n).length}  goodTrips>=0.01 ${good.length}  roundTrips>=0.01buy ${rt.length} on ${rtCoins} coins  dd ${r.maxDrawdown.toFixed(4)}  rejected ${r.rejected} ${JSON.stringify(r.rejectReasons)}  failed ${r.failed}`);
const noFail = simulate(ds, hello, createStrategy(params), { failKey: null });
const twoX = simulate(ds, hello, createStrategy(params), { feeMultiplier: 2n });
console.log(`without failed txs ${sol(noFail.netPnl)}  at 2x fees ${sol(twoX.netPnl)}`);
// concentration: net without the 3 best coins
const per = [...r.perMint.entries()].sort((a, b) => (a[1] > b[1] ? -1 : 1));
const top3 = per.slice(0, 3).reduce((s, [, v]) => s + v, 0n);
console.log(`top3 coins ${sol(top3)}  net ex-top3 ${sol(r.netPnl - top3)}  best coin ${per[0] ? per[0][0].slice(0, 8) + ' ' + sol(per[0][1]) : '-'}`);
