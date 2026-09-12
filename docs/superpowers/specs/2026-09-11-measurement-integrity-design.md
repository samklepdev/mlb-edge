# Measurement integrity: demo isolation, bulk ingest, data health

**Date:** 2026-09-11
**Status:** approved, not yet implemented

## Goal

Make the project's headline numbers trustworthy and their sufficiency legible:

1. Stop synthetic demo data from reaching CLV and calibration aggregates.
2. Make bulk historical ingest a single resumable command.
3. Surface whether there is enough history for projections to be
   player-specific rather than a restatement of the league prior.
4. Verify the two unconfirmed odds-api market keys.

**This does not make the model more accurate.** It stops fabricated data from
reaching results, makes ingest practical, and makes insufficiency visible. The
actual accuracy fix is ingesting a contiguous season, which is an operation, not
a code change. The health readout is how you will know when that has worked.

## The three problems, as measured

### Demo pollution

Every settled pick in the database is synthetic:

```
picks by date:   2026-09-11 -> 157  (unsettled, real)
                 2099-01-01 -> 160  (settled, demo seed)
settled picks:   160
```

The demo seed (`packages/pipeline/src/seed/demo.ts`) writes picks on
`game_id = 999999` / `DATE '2099-01-01'` with deliberately positive edges
(averaging +8% to +10%), including a `runs` prop the model does not project.

`getScorecard` (`packages/db/src/queries/scorecard.ts:12`) reads `FROM picks`
with no filter, as do `clvByProp` (`clv.ts:17`) and `calibrationBuckets`
(`calibration.ts:8`). So the dashboard's headline "does it beat the closing
line" question is currently answered entirely by fabricated data, and answered
"yes".

### History gaps

```
2025-09-04 -> 2025-09-11   (8 days)
   <- 11-month gap ->
2026-08-10 -> 2026-08-23   (14 days)
   <- 12-day gap ->
2026-09-04 -> 2026-09-10   (7 days)
```

~29 dates, 381 real games. `getBatterHistory` (`project/data.ts:79`) filters
only on `game_date < $1` with **no recency bound**, so a September 2026
projection pools September 2025 games at equal weight. `RECENT_DAYS = 30`
roster inference finds nothing across the gaps.

`ingest schedule` and `ingest games` each accept only a single `--date`, so
closing these gaps today means a hand-written shell loop that can fail silently
partway through.

### Shrinkage dominance

| | value |
|---|---|
| median batter PA (batters with >= 20 PA) | **60** |
| max batter PA | 121 |
| `K_PA` | **200** |

`shrinkRate` weights a player's own sample at `n / (n + K)`. At 60 PA that is
**23%** — roughly 77% of every batter's projected rate is the league prior. Even
the best-sampled batter in the set is only 38% himself.

This has a direct bearing on how the calibration numbers should be read:
predicting the base rate is well calibrated *by construction*. It is the same
reliability-without-resolution trap already documented for `home_runs`, except
here it applies to every prop, because there is not enough per-player history to
move off the prior. Nothing currently surfaces this.

## Design

### 1. Demo isolation — schema flag, not a magic ID

New migration `packages/pipeline/migrations/007_synthetic_flag.sql`:

```sql
ALTER TABLE games ADD COLUMN is_synthetic BOOLEAN NOT NULL DEFAULT false;
UPDATE games SET is_synthetic = true WHERE id = 999999;
```

`seed/demo.ts` sets `is_synthetic = true` explicitly when upserting its game, so
the flag survives a reseed rather than depending on the migration having run
first.

Three aggregate queries join `games` and exclude synthetic rows:
`getScorecard`, `clvByProp`, `calibrationBuckets`.

**Deliberately untouched:** the slate, top-edges, roster, and player-card
queries. The demo exists so a fresh clone shows a populated dashboard, and those
are the surfaces it legitimately populates. What it must never populate is a
*result*.

#### Why a flag rather than filtering on the ID or the date

Considered and rejected:

- **Filter on `game_id <> 999999` in the three queries.** Two lines, no
  migration — but it hard-codes a magic constant at three call sites and is
  fail-open: the next aggregate query silently pools fake data again. This is
  the same failure class as the `prop_type === 'total_bases' ? tb : so` ternary
  removed in the previous branch.
- **Purge the demo entirely.** Genuinely fail-closed, since no fake data would
  exist to pool. Rejected because it removes a legitimate feature: an empty
  database currently renders a populated dashboard.

The flag is still fail-open for a future query that forgets it, which is an
accepted limitation. It is chosen because it is greppable, self-documenting,
independent of both the magic ID and the sentinel date, and generalizes to any
future synthetic fixture.

### 2. Dashboard honesty — the part that does the real work

Filtering alone would turn the scorecard from "confidently wrong" into
"mysteriously empty". The failure being fixed was never that demo data existed;
it was that nothing on screen distinguished a demo number from a real one.

So where a panel is empty **because** synthetic rows were excluded, it must say
so in words — not render an empty chart or a zero. Specifically: when
`getScorecard` reports zero settled picks while synthetic picks do exist, the
dashboard states that the only settled picks present are demo data and that real
CLV requires running the forward loop.

### 3. Bulk ingest — `--from` / `--to`

`ingest schedule` and `ingest games` gain optional `--from` and `--to`. Existing
`--date` behavior is unchanged, and `--date` remains valid on its own.

Iteration is sequential and internal, printing per-date progress, so a long pull
is one interruptible command rather than a shell loop whose failures scroll past
unnoticed. A failure on one date reports and continues to the next, with a
summary count at the end — a single bad date must not abort a 120-day pull.

### 4. Data health — `npm run health`

A new CLI command, deliberately separate from `backtest`: `backtest` answers
"are the probabilities calibrated", `health` answers "is there enough data for
that answer to mean anything". Conflating them is what let the shrinkage problem
stay invisible.

Reports:

- **Date coverage** — contiguous ranges with gaps named explicitly. The current
  database prints as three ranges, not one span.
- **Batter PA distribution vs `K_PA`** — median, max, and the derived own-weight
  `n / (n + K_PA)` at the median.
- **Eval counts per prop.**
- **A plain-language verdict** on whether projections are meaningfully
  player-specific. This is the point of the command: at 23% own-weight it must
  say plainly that projections are mostly the league prior and that good
  calibration is therefore expected and not yet evidence of skill.

Verdict thresholds, on median own-weight `n / (n + K_PA)`:

| own-weight | median PA | verdict |
|---|---|---|
| `< 0.33` | `< ~100` | mostly league prior — calibration is not yet evidence of skill |
| `0.33` to `0.50` | `~100` to `200` | partially player-specific — read results with caution |
| `>= 0.50` | `>= 200` | player-specific — the player's own sample outweighs the prior |

The 0.50 boundary is not arbitrary: `n / (n + K)` reaches 0.5 exactly at
`n = K_PA`, the point where a batter's own record carries as much weight as the
league prior.

These thresholds are presentation only. They must not feed back into the model,
and `K_PA` must not be tuned in response to them.

### 5. Odds keys

`batter_hits` and `batter_home_runs` in `MARKET_TO_PROP` (`market/lines.ts`)
were never confirmed against the live API. Verify with a single events+odds
request during implementation and correct the mapping if the guess is wrong.
Free-tier quota is limited, so this is one request, not exploratory polling.

## Verification

No test runner exists in this repo, so verification is command-level:

1. `npm run typecheck` exits 0.
2. `npm run db:migrate`, then confirm the column:
   `docker compose exec db psql -U mlb -d mlb_edge -c "\d games"`.
3. `npm run build:db` — **required**, since `@mlb-edge/db` runs from `dist/`.
4. After the filter, scorecard and CLV report **zero** settled picks, proving
   the 160 synthetic ones are excluded. The dashboard shows the demo-data
   explanation rather than an empty chart.
5. `npm run health` output matches the independently measured values in this
   spec: median 60 PA, ~23% own-weight, three date islands.
6. `npm run ingest -- schedule --from <d> --to <d+2>` ingests three dates and
   reports per-date progress; `--date` alone still works.
7. `npm run seed:demo` followed by step 4 still shows zero settled picks,
   proving the flag survives a reseed.

## Out of scope

- Changing `K_PA`, `K_BF`, factor functions, or any model math.
- Adding a recency bound to `getBatterHistory`. It is a real modeling question
  (how stale is too stale) that deserves its own spec, and it interacts with the
  shrinkage constants.
- Removing the `runs` prop from the demo seeder, or making the seeder stop
  inventing results.
- RBI, or any new prop.
- Actually ingesting the season. That is the operation this work enables.
