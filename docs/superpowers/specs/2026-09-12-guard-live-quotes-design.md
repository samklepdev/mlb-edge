# Guard live in-game quotes out of `market_lines` — design

**Date:** 2026-09-12
**Status:** approved, ready for implementation plan
**Follows:** `2026-09-12-clv-capture-timing-design.md` (merged in `17bf9a3`)

## Problem

The capture-timing branch stopped `picks.close_line` recording live in-game
odds. It did **not** stop those odds entering the database in the first place.

`fetchLines` resolves an Odds API event to a DB game purely by team-name match
(`buildGameIndex`), with no start-time filter. On a partially-started slate it
therefore fetches and stores quotes for games already in progress, and
`storeLines` inserts them with a fresh `fetched_at`. Both readers of
`market_lines` prefer the newest row:

- `loadStoredLines` (`market/lines.ts`) — `ORDER BY … is_sharp DESC, fetched_at DESC`
- `getPlayerCard` (`packages/db/src/queries/player.ts`) — the same ordering

So a live in-game price wins.

**This is live, not theoretical.** Measured now:

| slate | live rows in `market_lines` | total rows |
|---|---|---|
| 2026-09-11 | 200 | 3756 |
| 2026-09-12 | 71 | 1628 |

and on today's slate, **52 of 761 player/game/prop keys currently resolve to a
quote fetched at or after first pitch**. Running `npm run lines -- reprice
--date 2026-09-12` today would price 52 props off in-game odds.

The damage path is worse than mispricing. `priceAndWritePicks` does
`DELETE FROM picks WHERE game_id = ANY($1)` and re-inserts. So a reprice after a
late capture would **destroy the `close_line`/`clv_pct`/`close_captured_at` just
captured** and replace the picks with ones whose `pick_fair_prob` is de-vigged
from a live price. The previous branch's filter cannot catch this: the
re-inserted rows have `close_captured_at` NULL (silently excluded, not flagged),
and the contamination sits in `pick_fair_prob`, not `close_*`.

A secondary cost: `fetchLines` calls `getEventOdds` once per matched event with
no start-time filter, so credits are spent on games whose data is unusable.
Quota is 204 of 500; a full fetch costs ~120.

## Design

### 1. Prevention — skip started games before the paid call

"Started" means `g.start_time <= now()` — the same wall-clock test
`captureClosing` already uses, so the two guards cannot disagree. A game with a
NULL `start_time` satisfies neither `<= now()` nor `> now()` and is therefore
**not** treated as started; only the synthetic sentinel has one, and it carries
zero `market_lines` rows (verified), so no real row is affected either way.

In `fetchLines`, fetch the slate's started-game ids once, then inside the event
loop, **after** the name match resolves a `gameId` but **before**
`getEventOdds`:

```ts
if (startedGames.has(gameId)) { skippedStarted++; continue; }
```

Position is load-bearing: after the match so the skip can be counted against a
real game, before the paid call so it saves the credit and prevents the row in
a single move.

This deliberately does **not** live in `buildGameIndex`. `match.ts` is about
name matching; scheduling logic belongs beside the timing code already in
`lines.ts`. `buildGameIndex` has exactly one caller, so there is no second
consumer to consider.

Applies to both `lines pull` and `lines capture`, since both go through
`fetchLines`. A started game's line cannot be acted on by either.

### 2. Diagnostics — do not misreport a started slate

`fetchLines` returns a new `skippedStarted: number` on `FetchResult`.

`lines pull`'s existing `matchedEvents === 0` branch reports *"events and DB
games both exist but none matched — likely a team-name mismatch"*. On a fully
started slate that is actively false. It needs a distinct branch reporting that
every matched event was skipped as already started.

This is the same class of defect the previous branch fixed in `capture`'s early
exit: a success-shaped or misleading message on the commands whose
trustworthiness is the entire point.

### 3. Read guard — protect against the 271 rows already stored

Add to both readers:

```sql
AND ml.fetched_at < g.start_time
```

- `loadStoredLines` already joins `games`; add the condition.
- `getPlayerCard`'s line query selects from `market_lines` alone and must gain
  a `JOIN games g ON g.id = ml.game_id`.

**Fallback is free.** `DISTINCT ON` applies `WHERE` before picking the first row
per group, so filtering a live row automatically falls back to the newest
*pre-start* row for that key. No fallback logic is needed, and none should be
written.

**NULL `start_time` excludes.** `ml.fetched_at < g.start_time` evaluates to NULL
— and therefore excludes — when `start_time` is NULL. Verified this drops
nothing today: zero `market_lines` rows join to a game with a NULL `start_time`,
and zero join to a synthetic game at all. Excluding rather than trusting is the
right default for an unverifiable timestamp, matching how the previous branch
treated a NULL `close_captured_at`.

### 4. No migration

`market_lines.fetched_at` is `NOT NULL DEFAULT now()` and already present on
every row. The guard is therefore **exact, not a proxy** — a materially stronger
guarantee than the previous branch's `close_captured_at`, whose history had to
be approximated. Nothing to backfill, no schema change.

### 5. Leave the 271 existing live rows in place

The read guard makes them inert, and they are evidence of what happened.
Non-destructive, consistent with how the previous branch handled contaminated
data.

## Expected effect

Measured before any code was written, on the 2026-09-12 slate:

| measure | before | after |
|---|---|---|
| keys resolving in `loadStoredLines` | 761 | **746** |
| keys resolving to a live quote | **52** | **0** |
| of those 52, falling back to a valid pre-start row | — | **37** |
| of those 52, dropped (no pre-start row exists) | — | **15** |

37 props get priced off a genuine pre-start line instead of an in-game one.
15 lose their line entirely and will not be priced.

**The 15 dropped keys are correct behaviour, not a regression.** No pre-start
price exists for them, so there is nothing honest to price against. `reprice`
will report slightly fewer picks; that must not be read as a failure.

## Verification

This repo has **no test runner, no test files, and no lint script**. Verification
is `npm run typecheck` plus database checks with exact expected values, matching
the convention of previous plans here.

1. `npm run typecheck` exits 0.
2. The 761 → 746 / 52 → 0 / 37 fallback / 15 dropped figures reproduce against
   the live database after the change.
3. `npm run lines -- reprice --date 2026-09-12` runs and its pick count is
   compared against the current 401, with the difference attributed.
4. `getPlayerCard` still returns lines for a player with pre-start data (the
   added `JOIN games` must not drop rows it should keep).
5. **Prevention proven without spending quota:** run the fetch path against a
   fully-started slate with `ODDS_API_KEY=` blanked. If the guard works, every
   matched event is skipped before `getEventOdds` and the key is never needed;
   if the guard is broken, the command fails on the missing key instead of
   spending ~120 of 204 remaining credits.
6. Quota checked before and after via the free `/sports` endpoint and confirmed
   identical.

## Out of scope

- No change to `MODEL_VERSION`, `K_BF`, `K_PA`, the edge threshold, or the
  de-vig method. This is measurement plumbing, not the model.
- No deletion or mutation of existing `market_lines` rows.
- No schema change, no migration.
- No dashboard changes beyond what the `getPlayerCard` guard implies.
- Does not address the absent *lower* bound on capture lead time (only 22 of the
  336 kept CLV rows were captured within an hour of first pitch). Recorded as a
  known seam; a separate question.

## Accepted risks

- **`pull` behaviour changes on a partially-started slate.** It will no longer
  store lines for started games. This is intended, but it is a silent reduction
  in stored history for anyone who relied on that data existing; the new
  `skippedStarted` diagnostic is what makes it visible.
- **The write path cannot be fully verified without spending credits.** As with
  the previous branch, the skip path is provable with a blanked key, but the
  behaviour of a real partially-started fetch gets its first live exercise on
  the next genuine capture.
- **15 keys lose pricing entirely** on today's slate, and the equivalent count
  on any future slate is unknown in advance.
