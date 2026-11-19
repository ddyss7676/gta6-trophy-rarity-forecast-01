# Model notes — gta6-trophy-rarity-forecast-01

## What is being forecast

For each of GTA VI's 55 PS5 trophies, the percent of the players Exophase tracks
for the game who will have earned it at 2026-11-26T00:00:00Z, as five quantiles
(5%, 25%, 50%, 75%, 95%). Scored by mean pinball loss on the **logit** scale, so
a miss from 1% to 2% costs about what a miss from 33% to 50% does, and rare
trophies count as much as common ones.

## The key observation

An Exophase rate is a ratio: `rate = earners / players_tracked`. The two sides
move for different reasons:

- `players_tracked` grows when more players sync their PSN profiles to Exophase.
  On launch night it jumped 638 → 3,868 in one refresh (~4.5 hours).
- `earners` grows when players actually earn the trophy. At that same refresh,
  total trophies earned went 943 → 4,276 — up 4.5x while the denominator went up
  6.1x, so **every rate but the 100% one fell**.

So a persistence forecast ("rates stay where they are") is wrong in both
directions at different horizons: over 90 minutes a refresh can push every rate
down ~25%; over 4.5 days player progression pushes story trophies far up. The
model forecasts earners and tracked players separately, in log game-age, and
divides.

## Specification

Let `x(t) = ln(1 + hours since 2026-11-19T00:00:00Z)`.

- **Tracked players:** OLS of `log N` on `x` over the case's distinct reads,
  slope shrunk toward 1.0 (near-linear growth in game age). Extrapolated to the
  target; slope clamped to [0, 1.6].
- **Earners per trophy:** OLS of `log E_i` on `x` (earners reconstructed as
  `rate × N / 100`, floored at 0.5 earners), slope shrunk toward a class prior
  with prior weight 3: platinum 1.3, gold 1.5, silver 1.6, secret bronze 1.6,
  other bronze 1.8. Slope clamped to [0.2, 2.6].
- **Median rate:** `E_i(target) / N(target)`, blended in logit space with a
  short-horizon refresh drift: weight `w = min(1, horizon_hours / 24)` on the
  slope forecast, `(1 − w)` on `ln(rho) × min(1, horizon_hours / 4)`, where
  `rho(h) = (1 + 1.86/(1+h)) / (1 + 27.85/(1+h))` is the rate multiplier of
  one refresh at game age `h` — 0.22 at launch (derived from the kit's
  documented first refresh: 638 → 3,868 tracked, 305 → 408 non-universal
  earners), rising toward 1 as the player base matures. The 100%-rate trophy
  is special-cased to stay ~100%.
- **Spread** (logit sd): `sqrt((0.5·√days)² + s_model² + s_refresh² (+ 0.3² if
  the history is flat and the horizon is ≥ 24h))`, where `s_model` is 0.45–0.65
  by tier and `s_refresh` is 0.30 for horizons under 12h, 0.15 otherwise.
  At short horizons the spread is asymmetric (lower sd ×1.3, upper sd ×0.8):
  the refresh branch sits below the median. Quantiles are the median shifted
  by the normal z-scores, rounded to 4 decimals.
- **Safeguards:** the extrapolated rate is capped at a tier ceiling
  (platinum 25%, gold 70%, silver 85%, bronze 97% — earners can never exceed
  the tracked players), and any single logit shift is capped at ±3.5 (a 33x
  odds move). Both bind only on absurd extrapolations, e.g. a steep prior
  slope carried seven days from a single launch-night read. The universal
  (100%) trophy is forecast at median 99.99 with a tight 0.35 logit spread
  through the same quantile machinery.

## Why this should beat the house baselines

- The persistence baseline's median never moves. Over the final's 4.5 days,
  story trophies will have moved by whole logit units; persistence scores that
  entire move as error. This model moves the median with fitted earners growth.
- The curve baseline fits the same flat launch-night reads, so on the practice
  it is persistence byte-for-byte (loss ≈ 1.51). On the final it fits a line to
  logit rates, which conflates denominator jumps with earner growth; splitting
  the ratio avoids that.
- The spread is wider than the house's at short horizons (refresh risk) and
  comparable at long horizons, so the forecast stays honest about what it does
  not know instead of paying for overconfidence.

## Validation

The practice answers are sealed server-side (the kit carries no
`reference/answer.json`), so no exact local practice loss exists. Validation
instead uses:

1. **A total-consistent reconstruction of the practice answers:** the kit's
   competition notes document the 04:30Z refresh (3,868 tracked, 4,276 earned).
   Scaling every launch-night rate by 4276/3868 ÷ 147.78 ≈ 0.748 reproduces
   those totals exactly; the scorer (pinball on the logit scale, implemented
   from RULES.txt) is run on that reconstruction, plus sensitivity scenarios
   (no refresh; early trophies falling less than late ones).
2. **A synthetic week-long case:** a fake final case with two days of history
   (power-law growth of tracked players, per-class earners growth, refresh
   steps) and a known truth at +4.5 days, checking the program beats
   persistence there — the regime the prize is actually decided in.

See the build report for the numbers.
