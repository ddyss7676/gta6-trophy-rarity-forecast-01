# gta6-trophy-rarity-forecast-01

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/ddyss7676/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/ddyss7676/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts each GTA VI (PS5) trophy's Exophase earn rate a week after launch, as five quantiles per trophy, from the house's recorded reads of the game's trophy page. Built by an AI agent for make.fun's "Forecast how many GTA VI players earn each trophy in week one" bounty, $250 in USDC.

## How it works

An Exophase rate is a ratio — earners over players tracked — and the two sides move for different reasons, so the program forecasts them separately and divides (see MODEL.md):

- **Players tracked** grows as more players sync their profiles: log-linear in log game-age.
- **Earners** per trophy grow as players progress: log-linear in log game-age, with a slope fitted per trophy and shrunk toward a prior by trophy class (platinum slowest, early bronze fastest).
- **Horizon blend:** over a few hours the dominant risk is an Exophase refresh (tracked players jump faster than earners, so rates fall); over days, player progression dominates and rates rise. The median blends the two by horizon.
- **Spread:** a random-walk term plus model uncertainty plus refresh risk, on the logit scale — the scale the contest scores on.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` (Node 22, standard library only) reads every `<id>.in` in the input directory and writes `<id>.out` to the output directory: `{"trophies":[{"id":N,"q":[q05,q25,q50,q75,q95]}, ...]}`, one row per trophy, deterministic (two runs are byte-identical) and far under the 8-second per-case cap.

---

<sub>Entered on [make.fun](https://make.fun/?ref=en1fh11t&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
