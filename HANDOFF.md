# mlb-edge — handoff

An honest MLB prop-betting research pipeline plus a web dashboard. The goal is
**not** to find clear-cut locks (they don't exist in a priced market). The goal
is a *calibrated* probability model and positive *closing line value (CLV)* —
the only two honest signals that an edge is real. The dashboard reports exactly
those two things and nothing hypey.

## Status

| Area | State |
|---|---|
| Phase 1 — ingestion (schedule, boxscores, raw capture) | ✅ implemented |
| Phase 2 — per-game rollups (batting + pitching) | ✅ implemented |
| Phase 3 — projections model (total_bases + strikeouts) | ✅ implemented |
| Phase 4 — market lines, edge picks, CLV capture, settling | ✅ implemented |
| Web dashboard (reliability plot, CLV table, scorecard) | ✅ implemented |
| Phase 5 — calibration loop / model tuning | ▶ ready to run on real picks |

Verified: `npm run typecheck` and `npm run web:build` are green; every command
below is wired as an npm script and resolves (checked via `--help`).

## Commands (all run from the repo root)

Every pipeline command is a root npm script. Args after `--` pass through to the
CLI; commands with subcommands (`ingest`, `lines`) take the subcommand first.

| Command | What it does |
|---|---|
| `npm run db:migrate` | apply migrations 001–004 |
| `npm run seed:demo` | insert SYNTHETIC settled picks (no API key needed) |
| `npm run ingest -- schedule --date <d>` | games, teams, probable pitchers |
| `npm run ingest -- games --date <d>` | box scores for FINAL games on `<d>` |
| `npm run ingest -- game --pk <gamePk>` | one box score by id |
| `npm run project -- --date <d> [--prop total_bases\|strikeouts\|all]` | write projections (distributions) |
| `npm run lines -- pull --date <d> [--books ..][--sharp ..][--regions ..][--edge ..]` | store lines + log edge picks |
| `npm run lines -- capture --date <d> [--sharp ..][--regions ..]` | record closing line + CLV on the slate's picks |
| `npm run settle -- --date <d>` | grade picks vs actual TB/SO from rollups |
| `npm run clv` | CLV report (CLI) |
| `npm run calibrate` | reliability report (CLI) |
| `npm run web:dev` / `npm run web:build` | dashboard at :3000 / prod build |
| `npm run typecheck` | build db + typecheck all three packages |

Fallback: any CLI command also runs via the passthrough
`npm run -w @mlb-edge/pipeline cli -- <args>` (e.g.
`npm run -w @mlb-edge/pipeline cli -- project --date 2025-09-11`). Prereqs:
Postgres running + migrated for anything that touches the DB; `ODDS_API_KEY` in
`.env` for `lines`. `seed:demo` is the no-key path to a populated dashboard.

## Setup

```bash
docker compose up -d          # Postgres on localhost:5432
npm install                   # also builds @mlb-edge/db (postinstall)
cp .env.example .env          # add ODDS_API_KEY for Phase 4 (the-odds-api.com)
npm run db:migrate
npm run seed:demo && npm run web:dev   # fastest way to see it working
```

## The full loop (one slate, with real data)

```bash
npm run ingest  -- schedule --date 2025-09-11        # games + probable pitchers
npm run project -- --date 2025-09-11                 # projections (distributions)
npm run lines   -- pull --date 2025-09-11 \
  --books draftkings,fanduel --sharp pinnacle --regions us,eu --edge 0.03
npm run lines   -- capture --date 2025-09-11 --sharp pinnacle --regions us,eu
# --- after games are final ---
npm run ingest  -- games --date 2025-09-11           # actual outcomes
npm run settle  -- --date 2025-09-11                 # result / won
npm run clv && npm run calibrate && npm run web:dev
```

## Layout (npm workspaces)

```
packages/db/         @mlb-edge/db — pg pool, config, types, and the
                     clvByProp / calibrationBuckets / getScorecard queries.
                     Compiles to dist/; both consumers import that.
packages/pipeline/   @mlb-edge/pipeline — the CLI. Modules:
                       ingest/    schedule + boxscores
                       project/   Phase 3 projection model
                       market/    Phase 4 lines, edges, CLV, settling
                       clients/   mlbStatsApi + oddsApi
apps/web/            @mlb-edge/web — Next.js 16 dashboard.
```

## Phase 4 — how it works (packages/pipeline/src/market/)

- **Lines** come from The Odds API v4 (`clients/oddsApi.ts`): events, then
  `batter_total_bases` / `pitcher_strikeouts` odds per event. Every book's line
  is stored in `market_lines` (`is_sharp` flags the reference book).
- **Pricing** (`market/prob.ts`): each projection's mean/stdev → `P(over line)`
  via a normal approximation (half-integer lines, so no continuity correction).
  The reference book's two-way price is de-vigged to a fair probability.
- **Edge** = `model_prob - fair_prob`; the side with positive edge is taken, and
  a pick is written when the edge clears `--edge`. `pick_fair_prob` is stored so
  CLV is principled.
- **CLV** (`lines capture`): re-fetch near close, recompute the fair prob of the
  taken side, set `clv_pct = close_fair_prob - pick_fair_prob`. Positive = the
  market moved toward you = you beat the close.
- **Settling** (`settle`): grade picks against actual TB/SO from the box-score
  rollups; sets `result` / `won`, which feeds calibration.

### Known integration seams (worth hardening)

- **Name/team matching** (`market/match.ts`) is normalized-string based. Player
  names can miss (Jr./accents/nicknames). `lines pull` reports the unmatched
  count — if it's high, add an alias table.
- **Normal approx** for `P(over)` is a v0 shortcut. Total bases is lumpy; a
  compound distribution over PAs is more correct. Projections store only
  mean/stdev, so upgrading means storing/recomputing the PMF.
- **Reference book**: pricing prefers `--sharp` if present, else the first stored
  book. Pinnacle usually needs `--regions us,eu`.

## Design decisions / gotchas

- **@mlb-edge/db compiles to dist**; both tsx and Next import the built output
  (`postinstall` builds it; `npm run -w @mlb-edge/db dev` to watch while editing).
- **Dashboard pages are `force-dynamic`**; `pg` is in `serverExternalPackages`;
  never import `@mlb-edge/db` from a `"use client"` file.
- **Lookahead guard**: projection history filters `game_date < target`.
  `raw_api_responses` stores payloads verbatim. `picks` is the single source for
  CLV + calibration; `lines pull` replaces a slate's picks idempotently and
  leaves demo/other games untouched.
- **MLB field paths** aren't verified against a live response here — sanity-check
  the first `ingest -- games`.

## Next steps

**Phase 5 — calibration loop (the payoff).** With real settled picks flowing,
watch the dashboard reliability plot and the CLI `calibrate` report. Pass/fail:
a straight reliability curve (per-bucket gap ≈ 0) and average CLV > 0. If points
sit below the diagonal, the model is overconfident — sweep `K_PA` / `K_BF` in
`project/model.ts`, re-project past slates, re-settle, compare ECE. Treat **CLV
as the leading indicator**: it resolves weeks before win/loss noise does.

**Worth adding next:** surface projections + open picks on the dashboard; an
alias table for name matching; the compound total-bases distribution; a
`backfill` command to project+price a date range for a first calibration sample.

**Guardrail (keep it in code and UI):** this is a learning + measurement tool.
Size any real bets as entertainment money. If it stops being fun or starts
feeling like chasing losses, that's the signal to stop — 1-800-GAMBLER.
