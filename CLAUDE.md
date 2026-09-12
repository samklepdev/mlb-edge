# Agent guide — mlb-edge

Read this before changing anything. `HANDOFF.md` is the longer reference (command
table, phase map, seams). This file is the load-bearing orientation.

## What this is
A TypeScript npm-workspace monorepo that measures whether an MLB player-prop
projection model beats a betting market. The goal is **honest measurement, not
winning**. Current state: model **v0.2** is calibrated per-prop (see the
`backtest` report for each prop's own ECE/Brier — a single pooled figure across
props with different base rates is not a meaningful summary, so there is no
one-number headline anymore) but has **not** been shown to beat the market —
that is what the forward CLV loop tests, and it is the main open question.

- `packages/db` (`@mlb-edge/db`) — pg pool, config, shared types, probability
  helpers (`prob.ts`), and the query layer. **Compiles to `dist/`.**
- `packages/pipeline` (`@mlb-edge/pipeline`) — the CLI; runs from source via tsx.
  Modules: `ingest/ project/ market/ backtest/ clients/`.
- `apps/web` (`@mlb-edge/web`) — Next.js 16 App Router dashboard.

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
Fallback: `npm run -w @mlb-edge/pipeline cli -- <args>`.

## Pipeline order (stages read the previous stage's output; dates must match)
`ingest schedule` → `ingest games` (box scores = the model's history) →
`project` (distributions → `projections.dist`) → `lines pull` (prices vs
de-vigged market, writes edge `picks`) → `lines capture` (closing lines → CLV; **must run BEFORE first pitch** — it
skips started games, because a price quoted after first pitch is a live
in-game price, not a closing one) →
`settle` (grade vs actual outcomes). `backfill` = project a past range + evaluate
vs reality; `backtest` = calibration report (reliability, ECE, Brier).

## Architecture facts (don't reverse-engineer these)
- Model projects `total_bases`, `hits`, `home_runs`, and `strikeouts`. Adding a
  prop = a new projector + a market-key mapping in `market/lines.ts` + candidate
  lines in `project/backfill.ts`.
- Core math is in `@mlb-edge/db/prob.ts` (`pOver`, `pOverFromPmf`, `deVig`),
  shared by pricing, backfill, and the player card. Don't duplicate it.
- `MODEL_VERSION` lives in `project/model.ts`; bump it on model changes. Pricing
  and backtest filter by version (latest wins).
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
- CLV rows captured after first pitch are excluded structurally
  (`picks.close_captured_at < games.start_time`). Historical values are
  approximated from `max(market_lines.fetched_at)` per slate — conservative, but
  estimates. Any CLV figure recorded before 2026-09-12 is contaminated: 164 of
  the first 500 rows were live in-game prices, including 124 of the 157 behind
  the old "+0.265%" result.

## Open work, prioritized
1. Run the forward CLV loop — the actual unanswered question.
2. Fill high-confidence backtest buckets; consider a `K_PA`/`K_BF` shrinkage sweep
   ONLY if the tail sag persists at large n.
3. Add props (hits → HRs), reusing the existing machinery.
4. Team win/margin — a **separate game-outcome model**, not a prop-model extension.

## Discipline to preserve (this is the point of the project)
- A large edge is a **hypothesis, not a green light**. The model is calibrated but
  crude; a sharp market usually knows what it's missing. CLV is the only real test.
- Don't tune to make one date window's ECE look good — that's overfitting. Prove
  any calibration change by re-backfilling and re-backtesting on a **different**
  date range.
- Don't dress up prop numbers as team/game predictions.
- Keep the responsible-gambling framing in code and UI. This is a measurement
  tool; the most likely honest finding is that the market is efficient — and
  reaching that conclusion correctly is a success, not a failure.
