# CLV capture timing — design

**Date:** 2026-09-12
**Status:** approved, ready for implementation plan

## Problem

`lines capture` records a "closing line" for every pick on a slate, with no
knowledge of when those games start. When it runs after first pitch, the odds
API returns **live in-game odds**, and those get written to `picks.close_line`
and folded into `clv_pct` as though they were closing prices.

This is not hypothetical. Measured on 2026-09-12:

| slate | CLV rows | captured post-start | share |
|---|---|---|---|
| 2026-09-11 | 157 | **124** | 79% |
| 2026-09-12 | 343 | **40** | 12% |
| **total** | **500** | **164** | **33%** |

A third of every CLV row this project has ever collected is contaminated.

The distortion is large and runs in **both directions**, so it is noise rather
than a correctable bias:

| slate | clean avg CLV | contaminated avg CLV |
|---|---|---|
| 2026-09-12 | −0.24% (n=303) | **−5.47%** (n=40) |
| 2026-09-11 | −0.13% (n=33) | **+0.37%** (n=124) |

On 2026-09-12, 12% of the sample produces roughly 70% of the apparent negative
CLV; the slate reads −0.85% but is −0.24% clean. On 2026-09-11 the last fetch
ran at 00:21 UTC the following day — after essentially the whole slate — which
means the **+0.265% "real CLV"** figure this project has carried as its headline
forward-test result rests on 124 rows of live in-game odds out of 157.

CLV is the project's one open question — the only real test of whether the model
beats the market. Answering it with 33% garbage is the exact failure
`CLAUDE.md` warns about: a number that looks like a finding but is an artifact.

## Root cause

`games.start_time` (`timestamptz`) **already exists and is 100% populated** —
2371/2371 non-synthetic games, written by `ingest/schedule.ts:32` from the
StatsAPI `gameDate`. It is read by **nothing**: a `grep` for `start_time` across
`packages/` and `apps/` returns only the two lines in `schedule.ts` that write
it.

So no new data is needed. The bug is that the pipeline never consults the field
it already has.

A second, related gap: `picks` has no record of *when* a close was captured.
`created_at` is when the pick was written, not when it was closed. Without that,
no read-time filter can tell a good historical capture from a bad one.

## Design

### 1. Schema — `008_pick_close_captured_at.sql`

Add the missing timestamp and backfill history from a proxy:

```sql
ALTER TABLE picks ADD COLUMN close_captured_at timestamptz;

-- Backfill: approximate each existing capture with the LAST market_lines fetch
-- for that slate. This is an approximation and is deliberately conservative --
-- using the latest fetch can only make a capture look later than it really was,
-- so it over-excludes rather than over-trusts. For a measurement tool that is
-- the correct direction to err.
UPDATE picks pk
SET close_captured_at = sub.last_fetch
FROM games g,
     (SELECT g2.game_date, max(ml.fetched_at) AS last_fetch
      FROM market_lines ml JOIN games g2 ON g2.id = ml.game_id
      GROUP BY g2.game_date) sub
WHERE g.id = pk.game_id
  AND sub.game_date = g.game_date
  AND pk.close_line IS NOT NULL
  AND pk.close_captured_at IS NULL;   -- idempotent re-run
```

The `IS NULL` guard makes the backfill safe to re-run. No index: `picks` is
small (hundreds of rows) and every CLV query already scans it.

**Demo-seed rows are untouched by construction.** 160 synthetic picks carry a
`close_line`, but the sentinel game (`2099-01-01`) has **zero** `market_lines`
rows, so the backfill's join matches nothing and leaves their
`close_captured_at` NULL — verified against the live database. They keep being
excluded from CLV exactly as `NOT g.is_synthetic` already excluded them, so the
demo seed's behaviour does not change. The synthetic game also has a NULL
`start_time`, which the new filter treats as "not verifiable" rather than
"trusted" — the correct default.

### 2. Capture guard — `captureClosing` in `market/lines.ts`

Three changes:

1. **Skip the API call entirely when no game on the slate is still upcoming.**
   Check for upcoming games *before* calling `fetchLines`. With 204 of 500
   credits left and a full fetch costing ~120, this is the difference between
   spending 120 credits and spending 0 on a slate that is already underway.
2. **Restrict the `openPicks` query** with `AND g.start_time > now()`, so picks
   on a started game are never written.
3. **Set `close_captured_at = now()`** in the `UPDATE`.

Return type changes from `number` to `{ updated, skipped, gamesStarted }` so the
CLI can explain *why* it skipped rather than silently reporting a low count.

`start_time > now()` uses wall-clock at capture time. A game in a rain delay
therefore counts as "started" — correct, because its market is no longer a
closing market either way.

### 3. CLV read filter

Exactly two sites read CLV; both get the same predicate appended to their
existing `close_line IS NOT NULL AND NOT g.is_synthetic`:

- `packages/db/src/queries/clv.ts` — `clvByProp` (CLI `clv` + dashboard per-prop table)
- `packages/db/src/queries/scorecard.ts` — three aggregates (`with_close`, `avg_clv`, `clv_games`)

```sql
AND pk.close_captured_at IS NOT NULL
AND pk.close_captured_at < g.start_time
```

Structural, mirroring how `NOT g.is_synthetic` was made structural in
`backtest.ts`: the guarantee then holds even if a future capture runs wrongly.

No other consumer touches `close_line` or `clv_pct` — verified by grep.

### 4. Surfacing first pitch

`lines capture` reports what it did and what the remaining window is:

```
captured 303 pick(s); skipped 40 on 3 game(s) already started
next first pitch 20:05 UTC (in 69m) · last 01:40 UTC
```

CLI only. The dashboard already has its own framing; adding a game-time column
there is a separate cosmetic change and is **out of scope**.

## Expected effect

Reported CLV becomes smaller and more honest, and `n` drops:

- 2026-09-12: −0.85% (n=343) → **≈ −0.24% (n=303)**
- 2026-09-11: loses 124 of 157 rows; the +0.265% headline does not survive

The falling `n` is the point, not a regression. It must be stated plainly in the
commit message rather than buried — a smaller honest sample is the deliverable.

## Verification

This repo has **no test runner, no test files, and no lint script**. Verification
is `npm run typecheck` plus database checks with exact expected values, matching
the convention of previous plans here.

1. `npm run db:migrate`, then confirm `close_captured_at` exists and that exactly
   **500** rows were backfilled — every non-synthetic row with a `close_line`.
   The 160 synthetic demo picks must remain NULL (verified above: no
   `market_lines` on the sentinel date).
2. Confirm the split: **164** rows have `close_captured_at >= start_time`
   (excluded), **336** have `close_captured_at < start_time` (kept).
3. `npm run build:db` — the CLV queries live in `@mlb-edge/db`, which runs from
   `dist/`; verify with `grep close_captured_at packages/db/dist/queries/*.js`.
4. `npm run clv` reports the clean figures with the reduced `n`.
5. Capture against an all-started slate makes **zero** API calls — quota
   identical before and after, checked via the free `/sports` endpoint.
6. `npm run typecheck` exits 0.

## Out of scope

- No dashboard changes.
- No change to `K_BF`/`K_PA`, the edge threshold, the de-vig method, or
  `MODEL_VERSION` — this touches measurement plumbing, not the model.
- No re-litigating the v0.3 pricing results; the falsified "picks drop to
  dozens" hypothesis stays logged and untuned.
- No backfill of `close_captured_at` for rows without a `close_line` (nothing to
  date-stamp).

## Accepted risks

- **The proxy backfill is permanent.** Historical `close_captured_at` values are
  approximations derived from `max(fetched_at)` per slate, not true capture
  times. They are conservative, but they are estimates and the migration says so.
- **A slate fetched only once cannot be distinguished.** If a slate's only
  `market_lines` fetch is its `pull`, the proxy stamps the close with the pull
  time. This under-states lateness in the one case where the pull preceded the
  capture but no capture fetch was recorded — such rows should not have a
  `close_line` at all, so the case is not expected to arise in practice.
