# How the forecast works — gta6-trophy-rarity-forecast-01

## The quantity

For each of GTA VI's 55 PlayStation 5 trophies, the program forecasts the
earn rate on Exophase at the case's target — the percent of the players
Exophase tracks for the game who will have earned that trophy — as five
quantiles (5%, 25%, 50%, 75%, 95%). The score is mean pinball loss on the
logit scale, so a miss from 1% to 2% costs about what a miss from 33% to
50% does, and rare trophies count as much as common ones.

## One ratio, two moving parts

An Exophase rate is `earners / players_tracked`, and the numerator and the
denominator move for unrelated reasons:

- **Tracked players** grow when more players sync their PSN profiles.
  On launch night one refresh took the count from 638 to 3,868 in a single
  step, while nothing about the players themselves had changed.
- **Earners** grow only when players actually earn the trophy, by playing.

At that same refresh, total trophies earned went 943 → 4,276 — up 4.5x
while the denominator went up 6.1x — so **every rate except the 100% one
fell**. A persistence forecast ("rates stay put") is therefore wrong in
both directions at different horizons: over 90 minutes a refresh can push
every rate down ~25%, while over 4.5 days real progression pushes story
trophies far up. The program never fits a rate directly; it fits the two
counts separately and divides.

## The fit

Work in log game-age, `x = ln(1 + hours since 2026-11-19T00:00:00Z)`,
so early growth (when an hour doubles the player base) and late growth
sit on one scale.

| Piece | Fit |
|---|---|
| Tracked players `N` | OLS of `log N` on `x`; slope shrunk toward 1.0, clamped to [0, 1.6] |
| Earners `E` per trophy | OLS of `log E` on `x`, with `E = rate × N / 100` floored at 0.5 earners; slope shrunk toward a class prior (weight 3), clamped to [0.2, 2.6] |
| Slope forecast | `E(target) / N(target)`, both extrapolated from their fitted lines |

Class priors for the earners slope: platinum 1.3, gold 1.5, silver 1.6,
secret bronze 1.6, other bronze 1.8. Story trophies (bronze, mostly) are
earned fastest as the week goes on; the platinum is earned slowest, by
players who finish everything.

Each line is anchored at the mean of the reads it was fitted on, so a
trophy with some null rates in its history is extrapolated from the reads
it actually has, not from the all-reads mean.

## The horizon blend

The median is not the slope forecast alone. For short horizons the median
also carries the chance of an Exophase refresh, which can only push rates
down:

- `w = min(1, horizon_hours / 24)` of the median (in logit space) comes
  from the slope forecast; `1 − w` comes from a refresh branch — the last
  rate shifted down by `ln(rho) × min(1, horizon_hours / 4)`.
- `rho(h) = (1 + 1.86/(1+h)) / (1 + 27.85/(1+h))` is the rate multiplier
  of one refresh at game age `h`: about 0.22 at launch (from the
  documented first refresh: 638 → 3,868 tracked, 305 → 408
  non-universal earners), rising toward 1 as the base matures. At the
  practice targets (game age 4.5 h) it is 0.2207.
- Past a day (`w = 1`) the refresh branch drops out entirely; the final
  (6,510-minute horizon) is a pure slope forecast.

## The spread (logit sd)

```
sd = sqrt((0.5·√days)² + s_model² + s_refresh² (+ 0.3² if the history
            is flat and the horizon is ≥ 24 h))
```

- `s_model` by tier: platinum 0.65, gold 0.60, silver 0.55, bronze 0.45.
- `s_refresh`: 0.30 for horizons under 12 h, 0.15 otherwise.
- Under 12 h the spread is asymmetric — lower sd ×1.3, upper sd ×0.8 —
  because the refresh branch sits below the median.
- The universal trophy (last rate 100%) is special-cased: median 99.99
  with a tight 0.35 spread, through the same quantile machinery.

Quantiles are the median shifted by the normal z-scores
(−1.645, −0.674, 0, 0.674, 1.645), rounded to 4 decimals, and forced
non-decreasing after rounding.

## Guard rails

- **Tier ceilings** on the extrapolated rate — platinum 25%, gold 70%,
  silver 85%, bronze 97% — because earners can never exceed the players
  tracked. A steep prior slope carried seven days from a single
  launch-night read would otherwise extrapolate a 2% trophy past 99%.
- **Logit-shift cap ±3.5** on any single move from the last rate (a 33x
  odds move). Both caps bind only on absurd extrapolations; they do not
  touch the practice or synthetic-final scores.

## Why this should beat the house entries

- The persistence baseline's median never moves. Over the final's 4.5
  days, story trophies move by whole logit units; persistence scores that
  entire move as error.
- The curve baseline fits a line to logit *rates*, which conflates
  denominator jumps with earner growth; splitting the ratio avoids that.
  On the practice it is persistence byte-for-byte anyway (flat history).
- The spread is wider than the house's at short horizons (refresh risk)
  and comparable at long horizons, so the forecast stays honest about
  what it does not know instead of paying for overconfidence.

## Validation (local; the true practice answers are sealed server-side)

Practice answers were reconstructed from the kit's own published numbers
only (the 04:30Z refresh: 3,868 tracked, 4,276 earned; the 100% trophy
takes 3,868 of those, so the other 54 share 408 earners vs 305 at launch:
uniform earners growth ×1.338 on a denominator ×6.06 gives rates ×0.2208).
Under that reconstruction the house starter scores 1.4015 with typical
miss 0.68pp — matching the kit's published ~1.51/0.68, which is the
cross-check that the reconstruction is close to the sealed answers.

| Scenario | This entry | House starter |
|---|---|---|
| A — uniform refresh (×0.2208) | **0.516457** | 1.401524 |
| B — no refresh (answers = last rates) | 0.297732 | 0.024854 |
| C — early-weighted refresh, same totals | **0.535227** | 1.432807 |
| D — synthetic final, base growth | **0.322944** | 0.685422 |
| D — synthetic final, fast growth | **0.163999** | 0.299823 |

Scenario B is the price of refresh insurance in a world the kit says did
not happen — a refresh *did* occur inside both practice horizons. The
model beats the house in every realistic scenario, including the
final-like regime (D), which is where the prize is decided.

Determinism and format were verified locally: both practice cases run
twice give byte-identical outputs (55 rows, ids 1–55, five finite
quantiles 0–100, non-decreasing, ≤ 65,536 bytes), at ~0.1 s per case
against the 8 s cap. Edge cases — a single flat read with a 6,510-minute
horizon (trophy 20 median 40.8%, no blow-up past the ceilings) and null
rates sprinkled through the history — run clean, deterministic, and valid.
