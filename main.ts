// gta6-trophy-rarity-forecast-01 — forecast each GTA VI (PS5) trophy's Exophase earn
// rate at the case's target, as five quantiles per trophy.
//
// Node 22, standard library only. Reads every <id>.in in the input directory and
// writes <id>.out to the output directory:
//   {"trophies":[{"id":N,"q":[q05,q25,q50,q75,q95]}, ...]}
//
// Model (my own design — counts, not rates):
//   An Exophase rate is a ratio, rate = earners / players_tracked. The two sides move
//   for different reasons, so I forecast them separately and divide:
//     * players_tracked N(t) grows as more players sync their profiles. I fit
//       log N against log game-age, x = ln(1 + hours since 2026-11-19T00:00Z),
//       shrinking the fitted slope toward 1.0 (near-linear growth in game age).
//     * earners E_i(t) per trophy grow as players progress through the game. I fit
//       log E_i against the same log game-age, shrinking the fitted slope toward a
//       prior by trophy class (platinum slowest, early bronze fastest).
//   The median rate is E_i(target) / N(target). When the history is flat (every
//   read identical, as on launch night) the fits fall back to the priors, so the
//   forecast still moves with the horizon instead of persisting.
//
//   Horizon blend: over a few hours the dominant risk is an Exophase *refresh* —
//   the page's counts jump in steps, and at a refresh the tracked-player count
//   jumps faster than the earners (the kit documents the first one: 638 -> 3,868
//   tracked, 943 -> 4,276 earned; the 100% trophy takes 3,868 of those earners,
//   so every other trophy's rate is multiplied by ~0.22). Over days, player
//   progression dominates instead. So for short horizons the median drifts down
//   with the expected number of refreshes (the multiplier rising toward 1 as
//   the player base matures), and the slope forecast takes over as the horizon
//   grows past a day.
//
//   Spread: a random-walk term (the house's 0.5 logit units per sqrt-day) plus a
//   model-uncertainty term (larger for rarer trophies) plus a refresh-risk term
//   (larger for short horizons). The 100%-rate trophy is special-cased: it stays
//   ~100% with a tiny spread.
//
// Everything is deterministic: pure arithmetic, no randomness, no network, no
// clock reads inside the forecast (only the case file's own times).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Random-walk spread, logit units per square-root day (the house's value). */
const SIGMA_RW = 0.5;
/** Game age zero: the release day begins. */
const T0 = Date.parse('2026-11-19T00:00:00Z');
/** Mean gap between Exophase refreshes of the game's counts, hours. */
const REFRESH_MEAN_HOURS = 4;
/** Refresh size vs game age, from the kit's documented first refresh
 *  (competition.yaml: 638 -> 3,868 tracked, 943 -> 4,276 earned). The 100%
 *  trophy holds one earner per tracked player, so the other 54 trophies went
 *  from 305 to 408 earners: J_N = 6.06, J_E = 1.34 at game age ~4.5h. Model
 *  each jump as 1 + k / (1 + h): J_N(h) = 1 + 27.85 / (1 + h),
 *  J_E(h) = 1 + 1.86 / (1 + h). A refresh multiplies a non-universal trophy's
 *  rate by rho(h) = J_E(h) / J_N(h): 0.22 at launch, rising toward 1 as the
 *  player base matures and new joiners stop dominating the counts. */
const refreshRho = (ageHoursTarget: number): number => {
  const jN = 1 + 27.85 / (1 + ageHoursTarget);
  const jE = 1 + 1.86 / (1 + ageHoursTarget);
  return jE / jN;
};
/** Prior slope of log players_tracked on log game-age. */
const PRIOR_BETA_N = 1.0;
/** Prior slopes of log earners on log game-age, by trophy class. */
const PRIOR_BETA_E: Record<string, number> = {
  platinum: 1.3,
  gold: 1.5,
  silver: 1.6,
  bronze: 1.8,
};
/** Prior slope for a secret bronze (collectibles / late content earn slower). */
const PRIOR_BETA_E_SECRET_BRONZE = 1.6;
/** Model-uncertainty spread (logit sd) by tier. */
const SPREAD_MODEL: Record<string, number> = {
  platinum: 0.65,
  gold: 0.55,
  silver: 0.5,
  bronze: 0.45,
};
/** Generous ceiling on a trophy's rate at the target, by tier: earners can
 *  never exceed the tracked players, and not everyone earns every trophy.
 *  Only binds on absurd extrapolations (e.g. a steep prior slope carried
 *  seven days from a single launch-night read). */
const RATE_CEILING: Record<string, number> = {
  platinum: 25,
  gold: 70,
  silver: 85,
  bronze: 97,
};
/** Largest logit shift the slope forecast may claim in one jump (33x odds).
 *  Binds only on absurd extrapolations; the real final moves ~1 logit. */
const MAX_DELTA_LOGIT = 3.5;

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
}
interface Read {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned: number;
  rates: Array<number | null>;
}
interface Case {
  levels: number[];
  horizon_minutes: number;
  target: string;
  at: string;
  game: { release_date?: string };
  trophies: Trophy[];
  history: Read[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogitPct = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
/** Game age in hours of an ISO timestamp, floored at 0. */
const ageHours = (iso: string, t0: number): number =>
  Math.max(0, (Date.parse(iso) - t0) / 3_600_000);
/** Log game-age coordinate. */
const xOf = (iso: string, t0: number): number => Math.log1p(ageHours(iso, t0));

/** Ordinary least squares slope of y on x; null when x has no variation. */
function olsSlope(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx < 1e-12) return null;
  return sxy / sxx;
}

/** Shrink a fitted slope toward a prior: weight m on the fit, k on the prior. */
function shrink(fit: number | null, prior: number, m: number, k: number): number {
  if (fit === null || !Number.isFinite(fit)) return prior;
  return (m * fit + k * prior) / (m + k);
}

function priorBetaE(t: Trophy): number {
  if (t.tier === 'bronze' && t.secret) return PRIOR_BETA_E_SECRET_BRONZE;
  return PRIOR_BETA_E[t.tier] ?? 1.6;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (c.history.length === 0) throw new Error(`${file} has no history`);
  const t0 = c.game?.release_date ? Date.parse(`${c.game.release_date}T00:00:00Z`) : T0;
  const horizonHours = c.horizon_minutes / 60;
  const horizonDays = c.horizon_minutes / 1440;
  const xTarget = xOf(c.target, t0);

  // Deduplicate the history: consecutive reads with identical counts carry no
  // new information (launch night is one flat page repeated). Keep the last read.
  const uniq: Read[] = [];
  for (const r of c.history) {
    const prev = uniq[uniq.length - 1];
    if (
      prev &&
      prev.players_tracked === r.players_tracked &&
      prev.rates.length === r.rates.length &&
      prev.rates.every((v, i) => v === r.rates[i])
    ) {
      continue;
    }
    uniq.push(r);
  }
  const last = c.history[c.history.length - 1];
  const xLast = xOf(last.at, t0);

  // --- players_tracked: log N on log game-age, shrunk toward PRIOR_BETA_N. ---
  const nPts = uniq.filter((r) => r.players_tracked > 0);
  const betaN = shrink(
    olsSlope(nPts.map((r) => xOf(r.at, t0)), nPts.map((r) => Math.log(r.players_tracked))),
    PRIOR_BETA_N,
    Math.max(0, new Set(nPts.map((r) => r.players_tracked)).size - 1),
    2,
  );
  const betaNc = Math.min(1.6, Math.max(0, betaN));
  const logNTarget = Math.log(last.players_tracked) + betaNc * (xTarget - xLast);

  // Horizon blend: slope forecast weight grows to 1 over a day; below that the
  // refresh expectation dominates the median drift. The drift is the log of
  // the refresh multiplier rho at the target's game age, times the expected
  // number of refreshes in the horizon.
  const wSlope = Math.min(1, horizonHours / 24);
  const expectedRefreshes = Math.min(1, horizonHours / REFRESH_MEAN_HOURS);
  const refreshDrift =
    Math.log(refreshRho(ageHours(c.target, t0))) * expectedRefreshes;

  const trophies = c.trophies.map((t, i) => {
    // The trophy everyone holds stays ~100%: it has been exactly 100% in
    // every read, and it is (by its launch-night rate) the trophy every
    // tracked player gets. Forecast it with the same machinery but a tight
    // spread — the logit scale punishes a low q05 far more than it rewards
    // one, and a hard-coded [99.5, ...] row scored worse than persistence.
    const lastRate = last.rates[i];
    if (lastRate !== null && lastRate !== undefined && lastRate >= 99.99) {
      const l = logit(99.99);
      const sUni = 0.35;
      let prev = -Infinity;
      const q = Z.map((z) => {
        const v = round4(Math.min(100, Math.max(0.01, invLogitPct(l + z * sUni))));
        const m = Math.max(v, prev);
        prev = m;
        return m;
      });
      return { id: t.id, q };
    }

    // Last non-null rate for this trophy (and the read it came from).
    let baseRate: number | null = null;
    let baseX = xLast;
    for (let j = c.history.length - 1; j >= 0; j--) {
      const r = c.history[j].rates[i];
      if (r !== null && r !== undefined) {
        baseRate = r;
        baseX = xOf(c.history[j].at, t0);
        break;
      }
    }
    if (baseRate === null) baseRate = 0.01;
    const baseEarners = Math.max(0.5, (baseRate * last.players_tracked) / 100);

    // Earners: log E on log game-age over the reads that have this trophy.
    const pts: Array<[number, number]> = [];
    for (const r of uniq) {
      const rate = r.rates[i];
      if (rate === null || rate === undefined || r.players_tracked <= 0) continue;
      const e = Math.max(0.5, (rate * r.players_tracked) / 100);
      pts.push([xOf(r.at, t0), Math.log(e)]);
    }
    const betaE = shrink(
      olsSlope(pts.map((p) => p[0]), pts.map((p) => p[1])),
      priorBetaE(t),
      pts.length,
      3,
    );
    const betaEc = Math.min(2.6, Math.max(0.2, betaE));

    // Median rate: slope forecast (earners / tracked at target) blended in logit
    // space with the short-horizon refresh drift.
    const logRateSlope =
      Math.log(baseEarners) + betaEc * (xTarget - baseX) - logNTarget;
    const medianSlope = Math.min(
      100 * Math.exp(logRateSlope),
      RATE_CEILING[t.tier] ?? 97,
    );
    const deltaSlope = Math.min(
      MAX_DELTA_LOGIT,
      Math.max(-MAX_DELTA_LOGIT, logit(medianSlope) - logit(baseRate)),
    );
    const delta = wSlope * deltaSlope + (1 - wSlope) * refreshDrift;
    // delta is a LOGIT shift: apply it on the logit scale (applying it as a
    // multiplicative factor on the rate is only valid for tiny rates, and
    // explodes past ~10% — e.g. 25.87% x exp(1.54) clamps to 99.99).
    const median = clampPct(invLogitPct(logit(baseRate) + delta));

    // Spread: random walk + model uncertainty + refresh risk (+ extra when the
    // history is flat and the horizon is long, so the median is prior-driven).
    // At short horizons the spread is asymmetric: the refresh branch sits
    // below the median, so the lower quantiles get more room than the upper.
    const sRw = SIGMA_RW * Math.sqrt(horizonDays);
    const sModel = SPREAD_MODEL[t.tier] ?? 0.5;
    const sRefresh = horizonHours < 12 ? 0.3 : 0.15;
    const sFlat = uniq.length <= 1 && horizonHours >= 24 ? 0.3 : 0;
    const s = Math.sqrt(sRw * sRw + sModel * sModel + sRefresh * sRefresh + sFlat * sFlat);
    const sLo = horizonHours < 12 ? s * 1.3 : s;
    const sHi = horizonHours < 12 ? s * 0.8 : s;

    const l = logit(median);
    let prev = -Infinity;
    const q = Z.map((z) => {
      const v = round4(Math.min(100, Math.max(0.01, invLogitPct(l + z * (z < 0 ? sLo : sHi)))));
      const m = Math.max(v, prev);
      prev = m;
      return m;
    });
    return { id: t.id, q };
  });

  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
