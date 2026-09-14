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
| Game-outcome model v0.1 — team runs → moneyline / run_line / total | ✅ built; roughly calibrated, **no measurable resolution** |
| Game model — `/team` measurement page (calibration + resolution verdict) | ✅ verdict-first; nothing priced |
| Game model — market lines, CLV, edge display | ⛔ not built (deliberate — see Next steps) |

Verified: `npm run typecheck` and `npm run web:build` are green.

## Kinds of "is it any good?"

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

And, for the **game-outcome model**, a third question that the prop side does not
ask yet:

3. **Resolution (no market needed).** Does the model carry any *information*, or
   is it just tracking base rates? `team-backtest` reports, per market, the
   advantage of the model's Brier score over a baseline that predicts each
   candidate line's own hit rate, with a 95% interval clustered by `game_id` (one
   game contributes up to 4 evals scored against one realized outcome). A
   well-calibrated model can score zero here; calibration and resolution are
   different properties, and this is the one that decides whether the model is
   worth pricing. **Current answer: no market has measurable resolution, and
   `total` is significantly worse than its baseline.**

## Commands (run from repo root; args after `--` pass through)

| Command | What it does |
|---|---|
| `npm run db:migrate` | apply migrations 001–009 |
| `npm run seed:demo` | synthetic settled picks (no API key) |
| `npm run ingest -- schedule --date <d>` / `-- games --date <d>` | schedule / box scores |
| `npm run project -- --date <d> [--prop ..]` | projections (distributions) |
| `npm run backfill -- --from <d> --to <d> [--prop ..]` | project a range + eval vs reality |
| `npm run backtest` | model-calibration report, per prop (ECE + Brier + reliability); pooled total is not comparable across prop mixes |
| `npm run lines -- pull --date <d> [--books ..][--sharp ..][--regions ..][--edge ..]` | store lines + log edge picks |
| `npm run lines -- capture --date <d> [..]` | closing line + CLV on the slate's picks — run before first pitch; skips started games and spends 0 credits if the whole slate has started |
| `npm run settle -- --date <d>` | grade picks vs actual box-score outcomes |
| `npm run clv` / `npm run calibrate` | CLI reports on settled picks |
| `npm run team-backfill -- --from <d> --to <d>` | **game model:** project team run distributions over a range (`team_projections`) + evaluate `moneyline`/`run_line`/`total` vs actual outcomes (`team_model_evals`) |
| `npm run team-backtest` | **game model:** per-market reliability, ECE, Brier, and the resolution verdict vs the per-line base rate. `--version/--from/--to` scope it; unflagged = latest version, all dates |
| `npm run verify:resolution` | executable checks for the resolution statistics — pure invariants plus SQL oracles pinned to the current eval population; run after any change to `resolution.ts` / `teamBacktest.ts` |
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

# the SEPARATE game-outcome model over the same history:
npm run team-backfill -- --from 2026-08-25 --to 2026-09-07
npm run team-backtest       # per-market ECE/Brier AND the resolution verdict
npm run verify:resolution   # the resolution math's own checks

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
packages/db/       @mlb-edge/db — pool, config, types, prob helpers,
                   resolution.ts (the advantage/interval/verdict math, pure),
                   and the query layer (clv, calibration, scorecard, slate,
                   player, backtest, teamBacktest). Compiles to dist/.
packages/pipeline/ ingest/ project/ (+backfill) game/ market/ backtest/ clients/
                   game/  = the SEPARATE game-outcome model: model.ts (its own
                            constants + TEAM_MODEL_VERSION), distribution.ts,
                            outcomes.ts, project.ts, backfill.ts
apps/web/          Next.js 16 — page.tsx, player/, _components/, api/
                   (prop model only; the game model has no page)
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
  now that `hits`/`home_runs` are in the mix (see "Kinds of 'is it any good?'"
  above).
- **`hits`@0.5 duplicates `total_bases`@0.5.** A batter records >=1 total base
  iff they record >=1 hit, so at the 0.5 line these two props grade the exact
  same event. `backtest` reports them separately (correctly — the market prices
  them as separate lines) but don't mistake two rows for two pieces of evidence.
- **Park/pitcher factors** are a stub table + a hits-allowed proxy. In the game
  model park factors are simply neutral (`PARK_FACTOR = 1.0`) and the bullpen is
  held at league average.
- **Game model: independent convolution.** `game/outcomes.ts` treats the two
  teams' run distributions as independent. They are not — a home team leading
  after 8.5 innings does not bat again — and this is the largest v0
  approximation.
- **Game model: in-sample league constants.** `RUNS_DISPERSION`, `LEAGUE_RUNS*`,
  `LEAGUE_ER_PER_BF`, `STARTER_OUT_SHARE` were measured over ~4730 team-games;
  `team-backtest` evaluates 4710 team-games. Essentially the same population, so
  the ECE figures are optimistic by an unmeasured amount.
- **Game model: the resolution baseline is per `(market, line)`.** Not per
  market — the model is told which line it is pricing, so the baseline must be
  too. `verify:resolution` pins this; don't collapse `baseRateBrier` back to
  `baseRate*(1-baseRate)`.
- **@mlb-edge/db compiles to dist** — after editing it, `npm run build:db`
  (or `npm run -w @mlb-edge/db dev` to watch). Never import it from a
  `"use client"` file; `pg` is in `serverExternalPackages`.

## Next steps

**Game-outcome model — built, but it has not earned a market path.** A separate
model now exists (`packages/pipeline/src/game/`, `TEAM_MODEL_VERSION =
game-v0.1`, tables `team_projections` / `team_model_evals`, migration
`009_team_model.sql`). It projects each team's runs as a negative binomial,
convolves the two, and derives `moneyline`, `run_line` (±1.5) and `total`
(7.5–10.5). It is **not** an extension of the prop model: separate version
column, separate tables, separate report, and no prop-model constants imported
under `game/`.

Measured on 2355 games (`npm run team-backtest`): ECE 0.031–0.051 per market,
so roughly calibrated — but **no market shows measurable resolution**. Against a
baseline that predicts each candidate line's own hit rate, `run_line` (+0.00036)
and `moneyline` (−0.00213) are indistinguishable from that baseline, and `total`
(−0.00581, 95% CI [−0.0098, −0.0019]) is *significantly worse*. The baseline is
per `(market, line)` on purpose: a pooled per-market rate would credit the model
for merely knowing which line it is pricing, since pooled
`r(1-r) = E[r_k(1-r_k)] + Var(r_k)`.

Two known approximations to attack before believing any of these numbers:
the two run distributions are convolved as **independent** (a home team leading
after 8.5 innings does not bat again), and the league constants in
`game/model.ts` were fitted on essentially the same team-games the backtest
evaluates, so the calibration figures are optimistic by an unmeasured amount.

Next steps on the game side, in order: (1) an innings-aware / correlated
convolution, with a `TEAM_MODEL_VERSION` bump and a re-`team-backfill`, judged
on *resolution*, not ECE; (2) out-of-sample constants; (3) only then a market
path — game lines (`h2h`, `spreads`, `totals`) into a `game_lines` table and a
pricing view separate from the existing `/team` measurement page. Pulling market
prices first would just show the market's consensus next to a model that has not
been shown to know anything, so it is deliberately not built. `/team` is not that
path: it reports calibration and the resolution verdict and prices nothing.

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
