# mlb-edge — handoff

An honest MLB prop-betting research pipeline plus a web dashboard. The goal is
**not** to find clear-cut locks (they don't exist in a priced market). The goal
is a *calibrated* probability model and positive *closing line value (CLV)* —
the only two honest signals that an edge is real. The dashboard exists to keep
that goal in view: it reports calibration error and CLV, nothing hypey.

## Status

| Area | State |
|---|---|
| Phase 1 — ingestion (schedule, boxscores, raw capture) | ✅ implemented |
| Phase 2 — per-game rollups (batting + pitching) | ✅ implemented |
| Web dashboard (reliability plot, CLV table, scorecard) | ✅ implemented |
| `projections`, `market_lines`, `picks` tables | ✅ created |
| CLV + calibration queries + CLI reports + demo seed | ✅ implemented |
| Phase 3 — projections model | ⛔ not started |
| Phase 4 — market lines + CLV capture | ⛔ not started (schema ready) |
| Phase 5 — calibration harness | ✅ read side done; needs real picks |

Verified locally: `npm run typecheck` passes for all three packages and
`npm run web:build` produces a clean production build.

## Layout (npm workspaces)

```
mlb-edge/
├─ packages/
│  ├─ db/         @mlb-edge/db — shared: pg pool, config, types, and the
│  │              clvByProp / calibrationBuckets / getScorecard queries.
│  │              Compiles to dist/ (js + d.ts); both consumers import that.
│  └─ pipeline/   @mlb-edge/pipeline — the CLI: ingestion, migrations,
│                 console reports, demo seed. Runs via tsx.
├─ apps/
│  └─ web/        @mlb-edge/web — Next.js 16 (App Router) dashboard.
│                 Reads Postgres in server components + /api routes.
├─ docker-compose.yml   Postgres 16
└─ tsconfig.base.json   shared compiler options
```

## Setup

```bash
docker compose up -d          # Postgres on localhost:5432
npm install                   # also builds @mlb-edge/db (postinstall)
cp .env.example .env          # defaults match docker-compose
npm run db:migrate            # create schema

# see the dashboard populated immediately with SYNTHETIC data:
npm run seed:demo
npm run web:dev               # http://localhost:3000

# or ingest real data (use a recent COMPLETED date):
npm run ingest -- schedule --date 2025-09-10
npm run ingest -- games    --date 2025-09-10
```

CLI reports: `npm run clv`, `npm run calibrate`.
JSON endpoints: `/api/clv`, `/api/calibration`.

## Design decisions / gotchas

- **@mlb-edge/db compiles to dist.** Both tsx (pipeline) and Next/Turbopack
  (web) import the built output, which sidesteps the `.js`-vs-`.ts` ESM
  resolution mismatch between NodeNext and the bundler. `postinstall` builds it;
  while editing db, run `npm run -w @mlb-edge/db dev` (tsc watch) alongside.
- **Dashboard pages are `force-dynamic`.** They query Postgres per request, so
  they are never prerendered at build (build works with no DB running).
- **`pg` is in `serverExternalPackages`** so the native driver is never bundled
  for the client. Never import `@mlb-edge/db` from a `"use client"` component.
- **`raw_api_responses` stores every payload verbatim with `fetched_at`.** This
  is what lets you re-derive stats without re-fetching and, crucially, backtest
  using only information available *before* each game (no lookahead bias).
- **`picks` is the single source for both CLV and calibration.** It records the
  model's probability and the line taken *before* the game, then `close_line` /
  `clv_pct` / `won` are filled later. Keep it that way.
- **MLB field paths** (`totalBases`, `inningsPitched`, etc.) are mapped from the
  documented shapes but not verified against a live response in this env. The
  raw payload is saved, so if a path drifts you fix the mapping and re-run.
  Sanity-check the first `ingest -- games` run against a box score you can eyeball.
- **PrizePicks has no official API.** Phase 4 should pull comparable + sharp
  lines via The Odds API (free tier; `ODDS_API_KEY` in `.env`) and treat sharp
  closing lines as the reference for de-vigging and CLV.

## Next steps

**Phase 3 — projections (start here).** Add `packages/pipeline/src/project/` that
reads `player_game_batting` / `player_game_pitching`, builds a regressed rolling
baseline per player (empirical-Bayes shrinkage toward league mean — do NOT use a
raw N-game average), adjusts for opposing starter handedness, park, and weather,
and writes a *distribution* (mean + stdev) to `projections`. Begin with ONE prop
(`total_bases` or `strikeouts`). Add a CLI command `project --date <d>`.

**Phase 4 — market + CLV.** Add an Odds API client, store lines in
`market_lines` (`is_sharp` for the reference book), de-vig, compute
`edge_pct = pick_prob - devigged_market_prob`, and write `picks`. Then a
`clv:capture` command that snapshots the closing line into `close_line` and sets
`clv_pct`. This is the point where the dashboard starts showing real numbers.

**Phase 5 — calibration loop.** The read side exists (`calibrationBuckets`,
`getScorecard`, the reliability plot). Once real picks settle, watch the plot:
the pass/fail is a straight curve (gap ≈ 0) and average CLV > 0. If the model is
overconfident (points below the diagonal), fix the shrinkage before trusting any
edge.

**Guardrail worth keeping in the code and the UI:** this is a learning +
measurement tool. Size any real bets as entertainment money. If it stops being
fun or starts feeling like chasing losses, that's the signal to stop — 1-800-GAMBLER.
