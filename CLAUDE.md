# Agent guide — mlb-edge

Read this before changing anything. `HANDOFF.md` is the longer reference (command
table, phase map, seams). This file is the load-bearing orientation.

## What this is
A TypeScript npm-workspace monorepo that measures whether MLB projection models
beat a betting market. The goal is **honest measurement, not winning**.

There are **two separate models**, with separate versions, tables and reports.
Never mix their numbers:

1. **Prop model** (`project/`, `MODEL_VERSION`, `projections` / `model_evals`,
   `backtest`). Current state: **v0.2**, calibrated per-prop (see the `backtest`
   report for each prop's own ECE/Brier — a single pooled figure across props
   with different base rates is not a meaningful summary, so there is no
   one-number headline anymore) but **not** shown to beat the market — that is
   what the forward CLV loop tests, and it is the main open question.
2. **Game-outcome model** (`game/`, `TEAM_MODEL_VERSION`, `team_projections` /
   `team_model_evals`, `team-backtest`). Current state: **game-v0.1**, a
   negative-binomial team-runs model convolved into `moneyline`, `run_line` and
   `total` probabilities. Roughly calibrated (ECE 0.031–0.051 per market) but
   **no market shows measurable resolution**: against a baseline that predicts
   each candidate line's own hit rate, `run_line` and `moneyline` are
   indistinguishable and `total` is **significantly worse**. That is the honest
   current finding. Do not tune it away; re-measure on a different date range.

- `packages/db` (`@mlb-edge/db`) — pg pool, config, shared types, probability
  helpers (`prob.ts`), resolution statistics (`resolution.ts`), and the query
  layer. **Compiles to `dist/`.**
- `packages/pipeline` (`@mlb-edge/pipeline`) — the CLI; runs from source via tsx.
  Modules: `ingest/ project/ game/ market/ backtest/ clients/`.
- `apps/web` (`@mlb-edge/web`) — Next.js 16 App Router dashboard. **Prop model
  only** — it does not surface the game model yet.

## Two build rules that cause every stumble here
1. **`@mlb-edge/db` runs from compiled `dist/`, not source.** After ANY edit to
   that package run `npm run build:db`, or the change is invisible at runtime.
   The pipeline runs from source (tsx), so its edits are live with no build.
2. **Schema changes need `npm run db:migrate`** (not automated — it mutates data).
   After pulling a fresh copy, run `npm install` (postinstall builds db) AND
   `npm run db:migrate`.

Verify before assuming a change took effect:
`grep <symbol> packages/db/dist/*.js` and `docker compose exec db psql -U mlb -d mlb_edge -c "\d <table>"`.

## Environment
- Postgres: `docker compose up -d`.
- `.env` at repo root; config searches upward, so it loads from any workspace cwd.
- `ODDS_API_KEY` (the-odds-api.com, free tier) is required for `lines` commands
  ONLY. The free tier has **no historical odds** — hence backtesting is
  model-vs-reality, not market-edge.

## Commands (root npm scripts; args after `--`)
`db:migrate` · `seed:demo` · `ingest -- schedule|games|game …` ·
`project -- --date <d>` · `backfill -- --from <d> --to <d>` · `backtest` ·
`lines -- pull|capture --date <d> …` · `settle -- --date <d>` · `clv` ·
`calibrate` · `web:dev`/`web:build` · `typecheck`.
Game-outcome model: `team-backfill -- --from <d> --to <d>` (project team run
distributions over a range + evaluate vs actual outcomes) · `team-backtest`
(per-market calibration + resolution report) · `verify:resolution` (executable
checks for the resolution statistics: pure invariants plus pinned SQL oracles —
run it after any change to `resolution.ts` or `teamBacktest.ts`).
Fallback: `npm run -w @mlb-edge/pipeline cli -- <args>`.

## Pipeline order (stages read the previous stage's output; dates must match)
`ingest schedule` → `ingest games` (box scores = the model's history) →
`project` (distributions → `projections.dist`) → `lines pull` (prices vs
de-vigged market, writes edge `picks`) → `lines capture` (closing lines → CLV; **must run BEFORE first pitch** — it
skips started games, because a price quoted after first pitch is a live
in-game price, not a closing one) →
`settle` (grade vs actual outcomes). `backfill` = project a past range + evaluate
vs reality; `backtest` = calibration report (reliability, ECE, Brier).

The game model has its own short chain off the same ingested box scores:
`ingest games` → `team-backfill` (team run PMFs → `team_projections`, then
market probabilities vs realized outcomes → `team_model_evals`) →
`team-backtest`. It does not read or write anything in the prop model's path and
has no market/CLV stage at all.

## Architecture facts (don't reverse-engineer these)
- The prop model projects `total_bases`, `hits`, `home_runs`, and `strikeouts`.
  Adding a prop = a new projector + a market-key mapping in `market/lines.ts` +
  candidate lines in `project/backfill.ts`.
- The game model (`game/`) projects each team's runs as a negative binomial
  (`game/distribution.ts`), convolves the two into a joint distribution, and
  derives `moneyline`, `run_line` (±1.5) and `total` (7.5–10.5) from it
  (`game/outcomes.ts`). Its constants and `TEAM_MODEL_VERSION` live in
  `game/model.ts` — kept deliberately separate from `project/model.ts`, so no
  prop-model constant is imported under `game/`.
- The resolution check (`@mlb-edge/db/resolution.ts` + `queries/teamBacktest.ts`)
  asks whether the game model has any information beyond the base rate. Its
  arithmetic is a pure function fed SQL sufficient statistics, and
  `verify:resolution` pins both. `MIN_GAMES = 30` and the conservative t-table
  are pre-registered floors, not knobs.
- Core math is in `@mlb-edge/db/prob.ts` (`pOver`, `pOverFromPmf`, `deVig`),
  shared by pricing, backfill, and the player card. Don't duplicate it.
- `MODEL_VERSION` lives in `project/model.ts`; bump it on model changes. Pricing
  and backtest filter by version (latest wins). `TEAM_MODEL_VERSION` in
  `game/model.ts` is the same contract for the game model. Both are selected
  with `max(model_version)`, a **lexicographic** comparison — so a bump without a
  re-backfill strands every existing row of the old version.
- Projections store the exact game PMF in `projections.dist`; pricing sums it
  (`pOverFromPmf`) instead of a normal approximation. This fixed a ~9pt
  overconfidence (v0.1 ECE 0.091 → v0.2 0.028) — both figures were measured over
  the original two-prop population (`total_bases`, `strikeouts`) and are not
  comparable to today's pooled four-prop numbers; see `backtest`'s per-prop
  output for the current, comparable figures.
- Dashboard pages are `force-dynamic`. **Never import `@mlb-edge/db` from a
  `"use client"` file** (`pg` is server-only; it's in `serverExternalPackages`).
- Lookahead guard: projection history queries filter `game_date < target`.
  `picks` is the single source for CLV + calibration; `lines pull` replaces a
  slate's picks idempotently. Demo seed lives on a sentinel date (2099-01-01).

## Known seams (documented, not bugs to "discover")
- Player/team name matching (`market/match.ts`) is normalized-string based; a few
  players miss. `lines pull` reports the unmatched count.
- Park factors are a stub table; the pitcher factor is a hits-allowed proxy.
- The per-PA independence assumption slightly understates variance (mild residual
  overconfidence in high-probability buckets at large n).
- Live in-game quotes are excluded at both ends: `fetchLines` skips games whose
  first pitch has passed (so they never reach `market_lines`, and no credit is
  spent on them), and both readers — `loadStoredLines` and `getPlayerCard` —
  require `market_lines.fetched_at < games.start_time`. That guard is exact:
  `fetched_at` is `NOT NULL` on every row. 271 live rows stored before the guard
  remain in the table but are inert.
- CLV reads (`clv.ts`, `scorecard.ts`) separately exclude any pick whose
  `close_captured_at` is null or `>= games.start_time`. Historical
  `close_captured_at` is a conservative proxy (`max(market_lines.fetched_at)` per
  slate), NOT a true timestamp — unlike the `fetched_at` guard above. Of the 164
  rows it excludes from the pre-2026-09-12 baseline, only 105 are provably
  post-first-pitch; the other 59 (all 2026-09-11) have no post-start quote and
  are excluded as unverifiable, not proven contaminated.
- Capture lead time has no LOWER bound: the guard only enforces "not after first
  pitch". None of the 33 kept CLV rows were captured within an hour of first
  pitch; all 33 were captured 1-3 hours out. "Closing line value" is still a
  generous label. (n was 336 as of the last count; it is 33 now because a
  `lines reprice` run against the 2026-09-12 slate, done as a verification step
  in this branch's own plan, deleted and re-inserted all of that slate's picks
  after its closes had been captured — wiping close_line/close_odds/
  close_fair_prob/clv_pct/close_captured_at/result on the 343 that had them,
  303 of which were clean. 14 of the slate's 15 games had already started, so
  those closes cannot be recaptured; the loss is permanent. The reported
  average CLV moving from −0.228% to −0.127% afterward is an artifact of that
  deletion, not a finding — see the `reprice` seam below for the guard added
  so this can't happen silently again.)
- `lines reprice` prices only games that have not started
  (`loadStoredLines` filters `g.start_time > now()`), so it writes no picks on
  games already underway. Started games' picks — and any captured closing lines
  on them — are preserved because `priceAndWritePicks` derives its
  `DELETE FROM picks WHERE game_id = ANY(...)` scope from the rows it is handed,
  and an excluded game never appears there. For upcoming games it still deletes
  and re-inserts, so it still refuses by default when an upcoming game already
  has a captured closing line; `--force` overrides and destroys them. All three
  `lines` commands now agree: none of them touch a game that has started.
- **Game model — independence of the two run distributions.** `game/outcomes.ts`
  convolves the home and away run PMFs as INDEPENDENT. They are not: a home team
  leading after 8.5 innings does not bat again, and scoring is correlated through
  the shared game state. This is the largest v0 approximation and biases the
  model in a known direction. It, not calibration tuning, is the next real lever.
- **Game model — league constants are fitted in-sample.** `RUNS_DISPERSION`,
  `LEAGUE_RUNS*`, `LEAGUE_ER_PER_BF` and `STARTER_OUT_SHARE` in `game/model.ts`
  were measured over ~4730 team-games, and `team-backtest` evaluates 2355 games
  (= 4710 team-games) — essentially the same population. The reported calibration
  is therefore optimistic by an unmeasured amount. Any calibration claim needs a
  date range those constants were not fitted on.
- **Game model — the resolution baseline is per `(market, line)`, not per
  market.** A market's evals span several candidate lines with very different hit
  rates (`run_line −1.5` hits 64.2%, `+1.5` hits 36.6%) and the model is told
  which line it is pricing. Since pooled `r(1-r) = E[r_k(1-r_k)] + Var(r_k)`, a
  pooled baseline would hand the model `Var(r_k)` — pure line identity — as
  "skill"; for `run_line` that term is 0.01905, which was essentially the whole
  advantage the pooled version reported. Don't "simplify" `baseRateBrier` back to
  `baseRate*(1-baseRate)`; `verify:resolution` pins this.
- **Game model — nothing beats its baseline yet.** As of `game-v0.1` on 2355
  games: `total` −0.00581, 95% CI [−0.0098, −0.0019] → **significantly worse**
  than predicting each line's own hit rate; `run_line` +0.00036 and `moneyline`
  −0.00213 → indistinguishable. A decent ECE here measures calibration, not
  information. This is the honest finding and the starting point for any further
  work on the model.

## Open work, prioritized
1. Run the forward CLV loop — the actual unanswered question.
2. Fill high-confidence backtest buckets; consider a `K_PA`/`K_BF` shrinkage sweep
   ONLY if the tail sag persists at large n. (Prop model only — `game/` keeps its
   own `MIN_BF_TEAM`, so a sweep cannot move game-model output.)
3. Add props (hits → HRs), reusing the existing machinery.
4. Game model: replace the independent convolution with an innings-aware /
   correlated one, and re-measure resolution. It is the largest known
   approximation and the leading *hypothesis* for the `total` result — not a
   demonstrated cause — and it is the one change worth trying before anything
   else on the game side. Needs a `TEAM_MODEL_VERSION` bump and a
   re-`team-backfill`; judge it on resolution, not ECE.
5. Game model: re-fit the `game/model.ts` league constants out-of-sample, or at
   minimum re-measure calibration on a range they were not fitted on.
6. Game model: no market/CLV path exists (no `game_lines` table, no dashboard
   page). Deliberate — there is nothing worth pricing until something beats its
   baseline.

## Discipline to preserve (this is the point of the project)
- A large edge is a **hypothesis, not a green light**. The model is calibrated but
  crude; a sharp market usually knows what it's missing. CLV is the only real test.
- Don't tune to make one date window's ECE look good — that's overfitting. Prove
  any calibration change by re-backfilling and re-backtesting on a **different**
  date range.
- Don't dress up prop numbers as team/game predictions, and don't pool the two
  models' figures — they measure different models on different populations.
- **Calibration is not information.** A model that always predicts the base rate
  is perfectly calibrated and worth nothing. For the game model, the number that
  matters is the resolution advantage against the per-line baseline, and it is
  currently ≤ 0 everywhere. `INDISTINGUISHABLE` is the default verdict, not a
  soft pass, and `WORSE` keeps its loud marker — don't soften either.
- Keep the responsible-gambling framing in code and UI. This is a measurement
  tool; the most likely honest finding is that the market is efficient — and
  reaching that conclusion correctly is a success, not a failure.
