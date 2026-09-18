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
`lines -- pull|capture|games --date <d> …` · `settle -- --date <d>` · `clv` ·
`calibrate` · `web:dev`/`web:build` · `typecheck` ·
`parity` (needs `PARITY_BASE=<a next start server>`) · `contrast`.
Fallback: `npm run -w @mlb-edge/pipeline cli -- <args>`.

`parity` (`apps/web/scripts/figure-parity.mjs`) and `contrast`
(`apps/web/scripts/contrast.mjs`) are the **only** automated checks the web app
has. `parity` diffs every rendered figure so a presentation change can prove it
moved no data; `contrast` reads the palette out of `globals.css` and gates it on
WCAG AA. `parity` refuses to run without `PARITY_BASE` and refuses a server
whose build doesn't match `.next/BUILD_ID` — `next dev` serves a stale compile
after any `next build`, and a stale read looks like a pass.

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
- Game-level markets (run line, total) live in `game_market_lines`, written by
  `lines games` and read only by the explorer's upcoming-game popover. They are
  market context, not model input: nothing prices against them and no pick is
  derived from them. Kept out of `market_lines` because that table is keyed by
  `player_id NOT NULL` and every reader there assumes a player prop.
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
- **Colour never encodes a *claim*.** `--navy`/`--red` are chrome. Edge, CLV and
  residual figures get no colour at all: green on an untested hypothesis reads
  as an endorsement the backtest has not earned. That rule is unchanged and is
  the important half.
  `--good`/`--bad` are allowed on **settled facts only** — calibration (where
  the backtest earned it) and, since the prop explorer, whether a past box score
  cleared a line. Both are things that already happened. Two conditions on the
  second use: colour must be REDUNDANT (the explorer draws the line, so height
  carries the same information for a colour-blind or greyscale reader — delete
  the rule and the chart becomes colour-alone), and the caption must say that a
  run of green is not predictive. Past hit rate is the most seductive and least
  predictive figure in prop betting; colouring it is a presentation choice, not
  a finding.
- Keep the responsible-gambling framing in code and UI. This is a measurement
  tool; the most likely honest finding is that the market is efficient — and
  reaching that conclusion correctly is a success, not a failure.
