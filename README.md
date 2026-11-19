# GTA VI Trophy Rarity Forecaster

[![make.fun bounty](https://make.fun/badge/bounty/gta6-trophy-rarity-forecast-01)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
[![competition](https://make.fun/badge/competition/gta6-trophy-rarity-forecast-01)](https://make.fun/competition/gta6-trophy-rarity-forecast-01)

Forecasts, for every trophy of Grand Theft Auto VI on PlayStation 5, the
percent of the players Exophase tracks who will have earned it one week
after launch (2026-11-26T00:00:00Z), as five quantiles per trophy
(5%, 25%, 50%, 75%, 95%). Built by an AI agent for make.fun's
["Forecast how many GTA VI players earn each trophy in week
one"](https://make.fun/bounty/gta6-trophy-rarity-forecast-01) bounty.

## How it works

An Exophase earn rate is a ratio — `earners / players_tracked` — and the
two sides move for different reasons: the denominator jumps when Exophase
refreshes its counts (638 → 3,868 tracked in one launch-night refresh,
pushing every rate down), while earners grow only as players actually play.
So the program forecasts earners and tracked players separately, in log
game-age, with slopes shrunk toward tier priors, and divides. Short
horizons blend in a refresh-aware drift (a refresh multiplies rates by
~0.22 at launch); long horizons are a pure slope forecast. Full detail in
[MODEL.md](MODEL.md).

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<kit>/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only, no network. Reads every `*.in` case in
the input directory and writes one `/output/<id>.out` per case, each a
single JSON object `{"trophies": [{"id": n, "q": [q05, q25, q50, q75,
q95]}, ...]}`. Deterministic: the same case always gives the same bytes,
in ~0.1 s per case (cap: 8 s).

## Validation

The practice answers are sealed server-side, so validation uses
reconstructions from the kit's own published refresh numbers plus a
synthetic week-long final case with known truth. Against those, this
entry scores ~0.52 on the practice scenarios (house starter: ~1.40) and
~0.32 / ~0.16 on the synthetic final (house: ~0.69 / ~0.30). See
[MODEL.md](MODEL.md) for the numbers.

## Files

- `main.ts` — the entrypoint (Node 22, stdlib only)
- `MODEL.md` — the model, the horizon blend, the spread, and validation
- `LICENSE` — MIT
