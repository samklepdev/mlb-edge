# mlb-edge — handoff

An honest MLB prop-betting research pipeline plus a web dashboard. The goal is
**not** clear-cut locks (they don't exist in a priced market) but a *calibrated*
model and positive *closing line value (CLV)* — the only honest signals an edge
is real. The dashboard reports exactly those, plus a per-player read for making
educated prop guesses.

## Status

| Area | State |
|---|---|
| Phase 1–2 — ingestion + per-game rollups | ✅ |
| Phase 3 — projections (total_bases, hits, home_runs, strikeouts) | ✅ |
| Phase 4 — market lines, edge picks, CLV, settling | ✅ |
| Phase 5 — model-calibration backtest (`backfill`/`backtest`) | ✅ |
| Model v0.2 — exact total-bases / strikeout distributions | ✅ (replaces normal approx) |
| Dashboard — backtest plot, slate browse, top edges, **player card** | ✅ |
| Team win / margin ("by how much") | ⛔ needs a game model — see Next steps |

Verified: `npm run typecheck` and `npm run web:build` are green.

## Two kinds of "is it any good?"

1. **Model calibration (no market needed).** Do the model's probabilities match
   reality? `backfill` projects past slates and, for finished games, evaluates
   `P(over line)` at standard lines against the actual stat, writing `model_evals`.
   `backtest` / the dashboard's top plot show the reliability curve, ECE, Brier.
   This is the honest first question and needs no odds data.
   **Read `backtest`'s per-prop output, not the pooled total.** Since the
   `hits`/`home_runs` props were added, the pooled ECE mixes four props with very
   different base rates and sample sizes and is not comparable across prop mixes
   (it also isn't comparable to the old two-prop v0.1/v0.2 figures below). Two
   traps in the raw numbers: `home_runs`' low ECE mostly reflects how rare home
   runs are (a rare-event base-rate guess is "calibrated" by construction, not
   because the model discriminates well), and `hits`@0.5 rows are exact
   duplicates of `total_bases`@0.5 rows (>=1 hit iff >=1 total base), so those
   two are one piece of evidence, not two.
2. **Market edge / CLV (needs live odds).** Whether the model beats a de-vigged
   market. The free Odds API has no *historical* odds, so this only accrues
   forward, slate by slate, via `lines pull` → `lines capture` → `settle`.

## Commands (run from repo root; args after `--` pass through)

| Command | What it does |
|---|---|
| `npm run db:migrate` | apply migrations 001–006 |
| `npm run seed:demo` | synthetic settled picks (no API key) |
| `npm run ingest -- schedule --date <d>` / `-- games --date <d>` | schedule / box scores |
| `npm run project -- --date <d> [--prop ..]` | projections (distributions) |
| `npm run backfill -- --from <d> --to <d> [--prop ..]` | project a range + eval vs reality |
| `npm run backtest` | model-calibration report, per prop (ECE + Brier + reliability); pooled total is not comparable across prop mixes |
| `npm run lines -- pull --date <d> [--books ..][--sharp ..][--regions ..][--edge ..]` | store lines + log edge picks |
| `npm run lines -- capture --date <d> [..]` | closing line + CLV on the slate's picks |
| `npm run settle -- --date <d>` | grade picks vs actual box-score outcomes |
| `npm run clv` / `npm run calibrate` | CLI reports on settled picks |
| `npm run web:dev` / `web:build` | dashboard at :3000 / prod build |
| `npm run typecheck` | build db + typecheck all packages |

Fallback for any command: `npm run -w @mlb-edge/pipeline cli -- <args>`.

## First real read (recommended path)

```bash
# load a couple of weeks of history, then backtest the MODEL against reality:
for d in 2026-08-25 2026-08-26 ... 2026-09-07; do
  npm run ingest -- schedule --date "$d"; npm run ingest -- games --date "$d";
done
npm run backfill -- --from 2026-08-25 --to 2026-09-07
npm run backtest            # ECE / Brier / reliability — is the model calibrated?
npm run web:dev             # same plot on the dashboard

# forward, for market edge (odds only exist for UPCOMING games):
npm run ingest  -- schedule --date <today>
npm run project -- --date <today>
npm run lines   -- pull --date <today> --sharp pinnacle --regions us,eu
npm run lines   -- capture --date <today> --sharp pinnacle --regions us,eu   # before first pitch
# after games: npm run ingest -- games --date <today> && npm run settle -- --date <today>
```

## Dashboard

- **Model calibration** — reliability plot from `model_evals` (run `backfill`).
- **Slate** — games with projections, and a **top-edges table**; each player row
  links to a **player card** (`/player?id=<id>&date=<date>`) showing every prop's
  projection, market line, model probability, de-vigged fair probability, edge,
  favored side, and whether a pick was logged. This is the prop-picking view.
- **Settled picks** — CLV + market reliability appear once real picks settle.

## Layout

```
packages/db/       @mlb-edge/db — pool, config, types, prob helpers, and the
                   query layer (clv, calibration, scorecard, slate, player,
                   backtest). Compiles to dist/.
packages/pipeline/ ingest/ project/ (+backfill) market/ backtest/ clients/
apps/web/          Next.js 16 — page.tsx, player/, _components/, api/
```

## Known seams

- **Name/team matching** (`market/match.ts`) is normalized-string based; a few
  players miss (Jr./accents). `lines pull` reports the unmatched count.
- **Exact distributions (v0.2).** `P(over)` now sums the projection's stored PMF
  (`projections.dist`) instead of a normal approximation — the projector convolves
  the per-PA outcome distribution over expected PAs. This fixed a ~9pt overconfidence
  (ECE 0.091 on v0.1). Re-run `backfill` then `backtest` to see the v0.2 curve —
  note the 0.091 → 0.028 v0.1/v0.2 figures were both measured on the original
  two-prop population (`total_bases`, `strikeouts`); read per-prop, not pooled,
  now that `hits`/`home_runs` are in the mix (see "Two kinds of 'is it any good'"
  above).
- **`hits`@0.5 duplicates `total_bases`@0.5.** A batter records >=1 total base
  iff they record >=1 hit, so at the 0.5 line these two props grade the exact
  same event. `backtest` reports them separately (correctly — the market prices
  them as separate lines) but don't mistake two rows for two pieces of evidence.
- **Park/pitcher factors** are a stub table + a hits-allowed proxy.
- **@mlb-edge/db compiles to dist** — after editing it, `npm run build:db`
  (or `npm run -w @mlb-edge/db dev` to watch). Never import it from a
  `"use client"` file; `pg` is in `serverExternalPackages`.

## Next steps

**Team win / margin — the next real modeling phase.** The current model is
player-props only; it does not predict who wins or by how much. That needs a
game-outcome model: e.g. aggregate the batting projections into expected team
runs (or a Poisson/Elo team model), then win probability and expected margin.
The honest interim is to pull game lines (`h2h`, `spreads`, `totals`) from the
Odds API into a `game_lines` table and show the **market's** de-vigged win prob
and run line on a `/game` page — clearly labeled as market consensus, not the
model. Then build the model version and compare, exactly like the player side.

**Model quality.** v0.2 replaced the normal approximation with exact distributions
(the biggest miscalibration fix). After pulling v0.2, re-measure:
```bash
npm run build:db && npm run db:migrate
npm run backfill -- --from <d> --to <d>   # re-projects v0.2 + re-evaluates
npm run backtest                          # per-prop ECE/Brier; pooled total is NOT
                                           # comparable to the v0.1 baseline (0.091)
```
Remaining levers if still overconfident: swap the stub park factors for real ones,
improve the pitcher factor (currently a hits-allowed proxy), and sweep `K_PA`/`K_BF`.
Confirm any gain holds on a DIFFERENT date range before trusting it (don't overfit
one window).

**Guardrail (keep it in code and UI):** this is a learning + measurement tool.
Size any real bets as entertainment money. A pile of "edges" is a pile of
hypotheses, not a bankroll. If it stops being fun or starts feeling like chasing
losses, stop — 1-800-GAMBLER.
