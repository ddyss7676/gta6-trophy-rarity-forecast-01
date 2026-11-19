// GTA VI trophy rarity forecaster — gta6-trophy-rarity-forecast-01
//
// For each trophy of Grand Theft Auto VI (PS5), forecasts the percent of the
// players Exophase tracks who will have earned it at the case's target, as
// five quantiles (5/25/50/75/95%). Scored by pinball loss on the logit scale.
//
// The core idea: an Exophase rate is a ratio, earners / players_tracked, and
// the two sides move for different reasons. Tracked players jump when
// Exophase refreshes its counts (638 -> 3,868 in one launch-night refresh),
// which pushes every rate down; earners grow as players actually play. So
// the program forecasts earners and tracked players separately, in log
// game-age, and divides. See MODEL.md for the full specification.
//
// Node 22, standard library only. No network, no randomness, no clock reads
// in the forecast path: the same case always gives the same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------- constants

const RELEASE_MS = Date.parse("2026-11-19T00:00:00Z"); // game release day start
const Z = [-1.645, -0.674, 0, 0.674, 1.645]; // normal quantiles, 5/25/50/75/95%

// Slope priors for log-earners growth, by trophy class (per log game-age).
const TIER_PRIOR: Record<string, number> = {
  platinum: 1.3,
  gold: 1.5,
  silver: 1.6,
  bronze: 1.8, // non-secret bronze; secret bronze uses 1.6
};
const SECRET_BRONZE_PRIOR = 1.6;

// Model uncertainty (logit sd) by tier.
const TIER_SPREAD: Record<string, number> = {
  platinum: 0.65,
  gold: 0.6,
  silver: 0.55,
  bronze: 0.45,
};

// A trophy's rate can never exceed its tier ceiling (earners <= tracked).
const TIER_CEILING: Record<string, number> = {
  platinum: 25,
  gold: 70,
  silver: 85,
  bronze: 97,
};

const PRIOR_WEIGHT = 3; // pseudo-count weight of a slope prior
const LOGIT_SHIFT_CAP = 3.5; // max single logit move from the last rate

// ------------------------------------------------------------------- helpers

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function logit(pct: number): number {
  const p = clamp(pct, 0.01, 99.99) / 100;
  return Math.log(p / (1 - p));
}

function invLogit(l: number): number {
  return 100 / (1 + Math.exp(-l));
}

function round4(v: number): number {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Log game-age: ln(1 + hours since the release day began). Pre-release
// reads sit slightly below zero (the 23:50 read is at -1/6 h); the log keeps
// them on the same scale instead of discarding them.
function gameAgeX(atMs: number): number {
  const h = (atMs - RELEASE_MS) / 3600000;
  return Math.log(Math.max(1 + h, 0.01));
}

// Ordinary least squares of y on x. Returns null slope when the fit is
// degenerate (fewer than two points, or all x identical).
function olsSlope(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx === 0) return null;
  return sxy / sxx;
}

// Shrink a fitted slope toward its prior: the prior counts as
// PRIOR_WEIGHT extra observations. With no fit at all, the prior is used.
function shrunkSlope(fit: number | null, prior: number, n: number): number {
  if (fit === null) return prior;
  return (n * fit + PRIOR_WEIGHT * prior) / (n + PRIOR_WEIGHT);
}

// Rate multiplier of one Exophase refresh at game age h (hours). Fitted to
// the documented first refresh: tracked 638 -> 3,868, non-universal earners
// 305 -> 408, so at h = 4.5 the multiplier is ~0.22; it rises toward 1 as
// the player base matures and a refresh stops moving the denominator much.
function refreshMultiplier(h: number): number {
  return (1 + 1.86 / (1 + h)) / (1 + 27.85 / (1 + h));
}

function tierOf(trophy: any): string {
  return String(trophy.tier || "bronze");
}

function priorFor(trophy: any): number {
  const tier = tierOf(trophy);
  if (tier === "bronze" && trophy.secret) return SECRET_BRONZE_PRIOR;
  return TIER_PRIOR[tier] ?? 1.8;
}

// -------------------------------------------------------------------- forecaster

interface Row {
  id: number;
  q: number[];
}

function forecastCase(c: any): { trophies: Row[] } {
  const trophies: any[] = c.trophies;
  const history: any[] = c.history ?? [];
  const horizonHours = (c.horizon_minutes as number) / 60;
  const horizonDays = horizonHours / 24;
  const targetMs = Date.parse(c.target);
  const xTarget = gameAgeX(targetMs);

  // The last read's rates, falling back to the most recent non-null read
  // per trophy when the last read lacks one.
  function lastRate(i: number): number | null {
    for (let k = history.length - 1; k >= 0; k--) {
      const r = history[k].rates?.[i];
      if (typeof r === "number" && Number.isFinite(r)) return r;
    }
    return null;
  }

  // Was the whole history one unchanged page? Then a long horizon carries
  // extra model risk (the page has never moved, so the fit says nothing).
  const flatHistory =
    history.length > 0 &&
    history.every(
      (h) =>
        h.players_tracked === history[0].players_tracked &&
        JSON.stringify(h.rates) === JSON.stringify(history[0].rates),
    );

  // --- tracked players: log N on log game-age, slope shrunk toward 1.0 ---
  const xs = history.map((h) => gameAgeX(Date.parse(h.at)));
  const xMean = xs.length ? mean(xs) : xTarget;
  const logN = history.map((h) => Math.log(Math.max(1, h.players_tracked)));
  const nSlopeRaw = shrunkSlope(olsSlope(xs, logN), 1.0, xs.length);
  const nSlope = clamp(nSlopeRaw, 0, 1.6);
  const logNTarget =
    (logN.length ? mean(logN) : Math.log(638)) + nSlope * (xTarget - xMean);
  const nTarget = Math.exp(logNTarget);

  // --- horizon blend weights ---
  // w: how much of the median comes from the slope forecast (1 past a day).
  // The rest is a refresh branch: the last rate drifted down by the log of
  // one refresh's multiplier, scaled by how much of a refresh window the
  // horizon covers (a refresh takes ~4 h to show up).
  const w = Math.min(1, horizonHours / 24);
  const driftScale = Math.min(1, horizonHours / 4);
  const gameAgeTargetH = (targetMs - RELEASE_MS) / 3600000;
  const driftLog = Math.log(refreshMultiplier(gameAgeTargetH)) * driftScale;

  // --- spread ---
  const refreshRisk = horizonHours < 12 ? 0.3 : 0.15;
  const walk = 0.5 * Math.sqrt(Math.max(horizonDays, 0));
  const flatExtra = flatHistory && horizonHours >= 24 ? 0.3 : 0;

  const rows: Row[] = [];
  for (let i = 0; i < trophies.length; i++) {
    const trophy = trophies[i];
    const tier = tierOf(trophy);
    const last = lastRate(i);
    const lastPct = last === null ? 0.01 : last;

    // A trophy every tracked player already holds stays ~100%: tight band.
    if (lastPct >= 100) {
      const med = logit(99.99);
      const sd = 0.35;
      const q = Z.map((z) => round4(invLogit(med + z * sd)));
      rows.push({ id: trophy.id, q: tidy(q) });
      continue;
    }

    // --- earners: log E on log game-age, slope shrunk toward tier prior ---
    const ex: number[] = [];
    const ey: number[] = [];
    for (let k = 0; k < history.length; k++) {
      const r = history[k].rates?.[i];
      if (typeof r !== "number" || !Number.isFinite(r)) continue;
      const earners = Math.max(0.5, (r * history[k].players_tracked) / 100);
      ex.push(xs[k]);
      ey.push(Math.log(earners));
    }
    const eSlopeRaw = shrunkSlope(
      olsSlope(ex, ey),
      priorFor(trophy),
      ex.length,
    );
    const eSlope = clamp(eSlopeRaw, 0.2, 2.6);
    // Anchor the line at the mean of the reads this trophy actually has:
    // with null rates sprinkled in, that mean differs from the all-reads
    // mean, and using the wrong anchor would bias the extrapolation.
    const exMean = ex.length ? mean(ex) : xMean;
    const logETarget =
      (ey.length ? mean(ey) : Math.log(0.5)) + eSlope * (xTarget - exMean);
    let slopeRate = (Math.exp(logETarget) / nTarget) * 100;
    if (!Number.isFinite(slopeRate) || slopeRate <= 0) slopeRate = lastPct;

    // Safeguards: tier ceiling, and no single logit move beyond +/-3.5.
    slopeRate = Math.min(slopeRate, TIER_CEILING[tier] ?? 97);
    const lastLogit = logit(lastPct);
    const slopeLogit = clamp(logit(slopeRate), lastLogit - LOGIT_SHIFT_CAP, lastLogit + LOGIT_SHIFT_CAP);

    // Median: blend the slope forecast with the refresh branch in logit space.
    const medLogit = w * slopeLogit + (1 - w) * (lastLogit + driftLog);

    const sModel = TIER_SPREAD[tier] ?? 0.45;
    const sdBase = Math.sqrt(
      walk * walk + sModel * sModel + refreshRisk * refreshRisk + flatExtra * flatExtra,
    );
    // At short horizons the refresh branch sits below the median, so the
    // lower tail is wider than the upper one.
    const sdLo = horizonHours < 12 ? sdBase * 1.3 : sdBase;
    const sdHi = horizonHours < 12 ? sdBase * 0.8 : sdBase;

    const q = Z.map((z) => {
      const sd = z < 0 ? sdLo : z > 0 ? sdHi : sdBase;
      return round4(invLogit(medLogit + z * sd));
    });
    rows.push({ id: trophy.id, q: tidy(q) });
  }
  return { trophies: rows };
}

// Round to 4 decimals, clamp into [0, 100], and keep the row non-decreasing
// (rounding can otherwise flip two nearly-equal quantiles).
function tidy(q: number[]): number[] {
  const out: number[] = [];
  for (let j = 0; j < q.length; j++) {
    let v = clamp(q[j], 0, 100);
    if (!Number.isFinite(v)) v = j === 0 ? 0 : out[j - 1];
    if (j > 0 && v < out[j - 1]) v = out[j - 1];
    out.push(v);
  }
  return out;
}

// ------------------------------------------------------------------------ main

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  mkdirSync(outputDir, { recursive: true });
  const files = readdirSync(inputDir)
    .filter((f) => f.endsWith(".in"))
    .sort();
  for (const file of files) {
    const c = JSON.parse(readFileSync(join(inputDir, file), "utf8"));
    const out = forecastCase(c);
    writeFileSync(join(outputDir, `${c.id}.out`), JSON.stringify(out));
  }
}

main();
