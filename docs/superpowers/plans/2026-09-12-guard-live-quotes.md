# Guard Live In-Game Quotes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop live in-game quotes entering `market_lines`, and stop the two readers preferring the 271 already stored.

**Architecture:** `fetchLines` gains a started-game set and skips a matched event *before* `getEventOdds` — preventing the row and saving the credit in one move. The two readers (`loadStoredLines`, `getPlayerCard`) gain `ml.fetched_at < g.start_time`, which `DISTINCT ON` turns into automatic fallback to the newest pre-start row. No schema change: `fetched_at` is already `NOT NULL` on every row, so the guard is exact rather than a proxy.

**Tech Stack:** TypeScript, npm workspaces, `tsx` (pipeline runs from source), Postgres 16 via `docker compose`.

**Spec:** `docs/superpowers/specs/2026-09-12-guard-live-quotes-design.md`

## Global Constraints

- **Odds API quota is 204 of 500 credits and a full fetch costs ~120. NO TASK MAY CALL THE ODDS API.** Never run `lines pull` or `lines capture` against a date with an upcoming game. The only sanctioned capture/pull command in this plan runs against the fully-completed slate `2026-09-11` with `ODDS_API_KEY=` blanked.
- **`@mlb-edge/db` compiles to `dist/` and runs from there.** Task 2 edits `packages/db/src/queries/player.ts`; without `npm run build:db` the change is invisible at runtime. This is the most common false-pass in this repo.
- **Do not change `MODEL_VERSION`, `K_BF`, `K_PA`, the edge threshold, or the de-vig method.** This is measurement plumbing, not the model.
- **No schema change, no migration, and no mutation of existing `market_lines` rows.** The 271 live rows stay; the read guard makes them inert.
- **"Started" means `g.start_time <= now() OR g.start_time IS NULL`** — the same wall-clock test `captureClosing` already uses, plus NULL treated as started so an unverifiable start time can't diverge from the read guard (which already excludes NULL), so the two guards cannot disagree.
- **`reprice` reading fewer lines is the intended outcome, not a regression.** Say so in the commit message rather than burying it.

## A note on testing

This repo has **no test runner, no test files, and no lint script** — verified across every `package.json`. Standing one up is not in scope. Verification is `npm run typecheck` plus database checks with exact expected values. Every expected number below was measured against the live database **before** any code was written, so the checks are falsifiable rather than self-confirming.

## Baseline measured before this work

| measure | baseline |
|---|---|
| live rows already in `market_lines` (2026-09-11) | 200 of 3756 |
| live rows already in `market_lines` (2026-09-12) | 71 of 1628 |
| keys `loadStoredLines` resolves for 2026-09-12 | **761** |
| of those, resolving to a quote fetched at/after first pitch | **52** |
| of those 52, with a pre-start row to fall back to | **37** |
| of those 52, with no pre-start row (will drop) | **15** |
| keys expected after the guard | **746** |
| games on 2026-09-11 (all completed) | 15 |

Note: an earlier `reprice` run today reported reading **708** lines. That predates the 18:50 capture, which added rows. The current pre-change figure is **761** — the contamination grew after that capture, which is exactly the mechanism this plan closes.

## Environment prerequisite

```bash
docker compose up -d
```

---

### Task 1: Skip started games before the paid call

**Files:**
- Modify: `packages/pipeline/src/market/lines.ts` (add `startedGameIds`; `FetchResult`; `fetchLines`; `PullResult`; `pullLines`)
- Modify: `packages/pipeline/src/cli.ts` (the `lines pull` action's diagnostics)

**Interfaces:**
- Produces:
  - `async function startedGameIds(date: string): Promise<Set<number>>` — module-private in `market/lines.ts`.
  - `FetchResult` gains `skippedStartedGames: number`.
  - `PullResult` gains `skippedStartedGames: number`. Consumed by the `lines pull` action in `cli.ts`.
- Consumes: the existing `query` import (already present at the top of `lines.ts`), `buildGameIndex`, `buildPlayerIndex`, `normalize`, `getEvents`, `getEventOdds`.

- [ ] **Step 1: Add the started-games helper**

In `packages/pipeline/src/market/lines.ts`, add immediately **above** the `FetchResult` interface (currently at line 38):

```ts
// Games on this slate whose first pitch has passed, or whose start_time is
// unverifiable. A NULL start_time satisfies neither `<= now()` nor `> now()`
// under a naive test, but the read guard (loadStoredLines, Task 2) already
// excludes an unverifiable start time's rows -- so this treats NULL as
// started too, to keep the two guards from disagreeing. Only the synthetic
// sentinel has one, and it carries no market_lines rows.
async function startedGameIds(date: string): Promise<Set<number>> {
  const res = await query<{ id: number }>(
    'SELECT id FROM games WHERE game_date = $1 AND (start_time <= now() OR start_time IS NULL)',
    [date],
  );
  return new Set(res.rows.map((r) => r.id));
}
```

- [ ] **Step 2: Extend `FetchResult`**

Replace:

```ts
interface FetchResult {
  rows: LineRow[];
  gameIds: number[];
  unmatchedPlayers: number;
  oddsEvents: number;   // events the Odds API returned
  dbGames: number;      // games in our DB for this date
  matchedEvents: number; // events that resolved to a DB game
}
```

with:

```ts
interface FetchResult {
  rows: LineRow[];
  gameIds: number[];
  unmatchedPlayers: number;
  oddsEvents: number;   // events the Odds API returned
  dbGames: number;      // games in our DB for this date
  matchedEvents: number; // events that resolved to a DB game
  skippedStartedGames: number; // matched events skipped because first pitch had passed
}
```

- [ ] **Step 3: Load the started set alongside the other indexes**

Replace:

```ts
  const [events, gameIndex, playerIndex] = await Promise.all([
    getEvents(),
    buildGameIndex(date),
    buildPlayerIndex(),
  ]);
```

with:

```ts
  const [events, gameIndex, playerIndex, startedGames] = await Promise.all([
    getEvents(),
    buildGameIndex(date),
    buildPlayerIndex(),
    startedGameIds(date),
  ]);
```

- [ ] **Step 4: Add the counter**

Replace:

```ts
  let unmatchedPlayers = 0;
  let matchedEvents = 0;
```

with:

```ts
  let unmatchedPlayers = 0;
  let matchedEvents = 0;
  let skippedStartedGames = 0;
```

- [ ] **Step 5: Skip started games before `getEventOdds`**

Replace:

```ts
    const gameId = gameIndex.get(`${normalize(ev.home_team)}|${normalize(ev.away_team)}`);
    if (gameId == null) continue; // event isn't on our slate for this date
    matchedEvents++;
    const odds = await getEventOdds(ev.id, MARKETS, opts.regions);
```

with:

```ts
    const gameId = gameIndex.get(`${normalize(ev.home_team)}|${normalize(ev.away_team)}`);
    if (gameId == null) continue; // event isn't on our slate for this date
    matchedEvents++;
    // A price quoted after first pitch is a LIVE in-game price. Skipping here --
    // after the match so it can be counted, BEFORE getEventOdds so it costs
    // nothing -- does double duty: the live quote never reaches market_lines
    // (where loadStoredLines and getPlayerCard would prefer it for being newest),
    // and no credit is spent fetching data we would refuse to use.
    if (startedGames.has(gameId)) { skippedStartedGames++; continue; }
    const odds = await getEventOdds(ev.id, MARKETS, opts.regions);
```

The ordering of these three lines is load-bearing. Do not move the skip above `matchedEvents++` (the count would under-report matches) or below `getEventOdds` (the credit would be spent).

- [ ] **Step 6: Return the new field**

Replace:

```ts
  return {
    rows,
    gameIds: [...gameIds],
    unmatchedPlayers,
    oddsEvents: events.length,
    dbGames: gameIndex.size,
    matchedEvents,
  };
```

with:

```ts
  return {
    rows,
    gameIds: [...gameIds],
    unmatchedPlayers,
    oddsEvents: events.length,
    dbGames: gameIndex.size,
    matchedEvents,
    skippedStartedGames,
  };
```

- [ ] **Step 7: Extend `PullResult` and thread it through `pullLines`**

Replace:

```ts
export interface PullResult {
  linesStored: number;
  picksWritten: number;
  matchedGames: number;
  unmatchedPlayers: number;
  oddsEvents: number;
  dbGames: number;
  matchedEvents: number;
}
```

with:

```ts
export interface PullResult {
  linesStored: number;
  picksWritten: number;
  matchedGames: number;
  unmatchedPlayers: number;
  oddsEvents: number;
  dbGames: number;
  matchedEvents: number;
  skippedStartedGames: number;
}
```

Then in `pullLines`, replace its destructuring line:

```ts
  const { rows, gameIds, unmatchedPlayers, oddsEvents, dbGames, matchedEvents } = await fetchLines(date, opts);
```

with:

```ts
  const { rows, gameIds, unmatchedPlayers, oddsEvents, dbGames, matchedEvents, skippedStartedGames } =
    await fetchLines(date, opts);
```

and add `skippedStartedGames,` to the object it returns, immediately after `matchedEvents,`.

`captureClosing` also calls `fetchLines` and destructures only `{ rows }`; it needs no change.

- [ ] **Step 8: Report skips in `lines pull`**

In `packages/pipeline/src/cli.ts`, in the `lines pull` action, replace:

```ts
    if (r.matchedEvents === 0) {
      if (r.oddsEvents === 0) {
        console.log(
          'Hint: the Odds API returned no events. It only covers current/upcoming games — ' +
            `${o.date} may be in the past or have no slate.`,
        );
      } else if (r.dbGames === 0) {
        console.log(`Hint: no games in the DB for ${o.date}. Run: npm run ingest -- schedule --date ${o.date}`);
      } else {
        console.log('Hint: events and DB games both exist but none matched — likely a team-name mismatch.');
      }
    } else if (r.picksWritten === 0 && r.linesStored > 0) {
      console.log('Hint: lines stored but no edges. Run `project` for this date first, or lower --edge.');
    }
```

with:

```ts
    if (r.skippedStartedGames > 0) {
      console.log(
        `skipped ${r.skippedStartedGames} matched event(s) whose game had already started ` +
          '— a price quoted after first pitch is a live in-game price, not a market you can bet',
      );
    }
    if (r.matchedEvents === 0) {
      if (r.oddsEvents === 0) {
        console.log(
          'Hint: the Odds API returned no events. It only covers current/upcoming games — ' +
            `${o.date} may be in the past or have no slate.`,
        );
      } else if (r.dbGames === 0) {
        console.log(`Hint: no games in the DB for ${o.date}. Run: npm run ingest -- schedule --date ${o.date}`);
      } else {
        console.log('Hint: events and DB games both exist but none matched — likely a team-name mismatch.');
      }
    } else if (r.skippedStartedGames === r.matchedEvents) {
      console.log(
        `Hint: all ${r.matchedEvents} matched event(s) had already started, so nothing was stored. ` +
          'Run `lines pull` before first pitch.',
      );
    } else if (r.picksWritten === 0 && r.linesStored > 0) {
      console.log('Hint: lines stored but no edges. Run `project` for this date first, or lower --edge.');
    }
```

The new `skippedStartedGames === matchedEvents` branch closes a silent-zero gap: when every matched event has started, `matchedEvents > 0` so the team-name-mismatch hint does not fire, and `linesStored === 0` so the no-edges hint does not fire either — the operator previously got no explanation at all.

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`

Expected: exits 0. A type error at the `pullLines` return or the `cli.ts` action means Step 7 or 8 was skipped.

- [ ] **Step 10: Prove the skip fires without spending quota**

`2026-09-11` is a fully completed slate (15 games, all started), so every matched event must be skipped and `getEventOdds` must never be called. Blanking the key makes a broken guard fail for free instead of spending ~120 of 204 remaining credits:

```bash
ODDS_API_KEY= npm run lines -- pull --date 2026-09-11
```

Expected: the command reaches the skip path and reports `skipped N matched event(s) whose game had already started`, with `stored 0 line(s)`.

**If this fails with a missing/invalid API key error, the guard did NOT fire before `getEventOdds` — it is broken. Stop and fix it; do NOT proceed to Step 11.**

Note: `getEvents()` runs before the per-event loop, so with a blanked key this command may fail at `getEvents` rather than reaching the loop. If it does, that is NOT proof of a working guard — it is an inconclusive run. In that case, verify instead by reading the code path and confirm with the psql check in Step 11, and say plainly in your report that Step 10 was inconclusive.

- [ ] **Step 11: Confirm the started set is what the guard will see**

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT count(*) FILTER (WHERE start_time <= now()) AS started,
          count(*) FILTER (WHERE start_time >  now()) AS upcoming,
          count(*) AS total
   FROM games WHERE game_date = '2026-09-11' AND NOT is_synthetic;"
```

Expected exactly: `15|0|15`. Every game on that slate is started, so the guard would skip every matched event for it.

- [ ] **Step 12: Confirm quota was not spent**

```bash
set -a; . ./.env; set +a
curl -s -D - -o /dev/null "https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}" | grep -i x-requests-remaining
```

Expected: **204**, unchanged from the baseline. The `/sports` endpoint is free. Do not print the API key.

- [ ] **Step 13: Commit**

```bash
git add packages/pipeline/src/market/lines.ts packages/pipeline/src/cli.ts
git commit -m "Skip started games before fetching their odds

fetchLines matched Odds API events by team name with no start-time
filter, so a partially-started slate stored LIVE in-game quotes into
market_lines -- which both readers then prefer, being newest. Skipping
after the match but before getEventOdds prevents the row and saves the
credit in one move.

Also closes a silent-zero gap in pull's diagnostics: when every matched
event had started, neither existing hint fired and the operator got no
explanation for a zero-line pull."
```

---

### Task 2: Make both readers ignore live quotes

**Files:**
- Modify: `packages/pipeline/src/market/lines.ts` (`loadStoredLines`, the query at lines 235-241)
- Modify: `packages/db/src/queries/player.ts` (the `lines` query at lines 30-39)

**Interfaces:**
- Consumes: nothing from Task 1 — these are independent changes to read paths.
- Produces: no signature changes. `loadStoredLines` still returns `LineRow[]`; `getPlayerCard` keeps its existing return type. Only the rows they see change.

These are the **only** two readers of `market_lines` that choose a preferred row. Do not go looking for a third.

- [ ] **Step 1: Guard `loadStoredLines`**

In `packages/pipeline/src/market/lines.ts`, replace:

```ts
    `SELECT DISTINCT ON (ml.player_id, ml.game_id, ml.prop_type)
            ml.player_id, ml.game_id, ml.prop_type, ml.line,
            ml.over_odds, ml.under_odds, ml.source, ml.is_sharp
     FROM market_lines ml JOIN games g ON g.id = ml.game_id
     WHERE g.game_date = $1
     ORDER BY ml.player_id, ml.game_id, ml.prop_type, ml.is_sharp DESC, ml.fetched_at DESC`,
```

with:

```ts
    `SELECT DISTINCT ON (ml.player_id, ml.game_id, ml.prop_type)
            ml.player_id, ml.game_id, ml.prop_type, ml.line,
            ml.over_odds, ml.under_odds, ml.source, ml.is_sharp
     FROM market_lines ml JOIN games g ON g.id = ml.game_id
     WHERE g.game_date = $1
       -- A quote fetched at or after first pitch is a LIVE in-game price. The
       -- ORDER BY below prefers the newest row, so without this a late capture's
       -- live quote would win. DISTINCT ON applies WHERE first, so excluding the
       -- live row falls back to the newest PRE-START row for that key at no cost
       -- -- no fallback logic is needed here.
       -- NULL start_time makes this NULL, i.e. excluded: an unverifiable
       -- timestamp is not trusted (matches how close_captured_at treats NULL).
       AND ml.fetched_at < g.start_time
     ORDER BY ml.player_id, ml.game_id, ml.prop_type, ml.is_sharp DESC, ml.fetched_at DESC`,
```

- [ ] **Step 2: Guard `getPlayerCard`**

In `packages/db/src/queries/player.ts`, replace:

```ts
      `SELECT DISTINCT ON (game_id, prop_type)
              game_id, prop_type, line, over_odds, under_odds
       FROM market_lines
       WHERE player_id = $1
       ORDER BY game_id, prop_type, is_sharp DESC, fetched_at DESC`,
```

with:

```ts
      // Same guard as loadStoredLines: a quote fetched at or after first pitch is
      // a live in-game price, and this ORDER BY would otherwise prefer it for
      // being newest. Requires the games join, which this query did not have.
      `SELECT DISTINCT ON (ml.game_id, ml.prop_type)
              ml.game_id, ml.prop_type, ml.line, ml.over_odds, ml.under_odds
       FROM market_lines ml JOIN games g ON g.id = ml.game_id
       WHERE ml.player_id = $1
         AND ml.fetched_at < g.start_time
       ORDER BY ml.game_id, ml.prop_type, ml.is_sharp DESC, ml.fetched_at DESC`,
```

Every column reference gains the `ml.` prefix because the query now has two tables. The returned column names are unchanged, so the `lineMap` built from these rows needs no edit.

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck`

Expected: exits 0. This also runs `build:db`, which is mandatory — `player.ts` lives in `@mlb-edge/db`, which runs from `dist/`.

- [ ] **Step 4: Confirm the compiled output carries the guard**

```bash
grep -c "fetched_at < g.start_time" packages/db/dist/queries/player.js
```

Expected: **1**. A `0` means the build did not pick up the edit and every check below is meaningless.

- [ ] **Step 5: Verify the guard's effect on today's slate**

This is the number the whole task turns on:

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c "
WITH before AS (
  SELECT DISTINCT ON (ml.player_id, ml.game_id, ml.prop_type)
         ml.player_id, ml.game_id, ml.prop_type, ml.fetched_at, g.start_time
  FROM market_lines ml JOIN games g ON g.id=ml.game_id
  WHERE g.game_date='2026-09-12'
  ORDER BY ml.player_id, ml.game_id, ml.prop_type, ml.is_sharp DESC, ml.fetched_at DESC),
after AS (
  SELECT DISTINCT ON (ml.player_id, ml.game_id, ml.prop_type)
         ml.player_id, ml.game_id, ml.prop_type
  FROM market_lines ml JOIN games g ON g.id=ml.game_id
  WHERE g.game_date='2026-09-12' AND ml.fetched_at < g.start_time
  ORDER BY ml.player_id, ml.game_id, ml.prop_type, ml.is_sharp DESC, ml.fetched_at DESC)
SELECT (SELECT count(*) FROM before) AS keys_before,
       (SELECT count(*) FROM after)  AS keys_after,
       (SELECT count(*) FROM before WHERE fetched_at >= start_time) AS were_live,
       (SELECT count(*) FROM before b WHERE b.fetched_at >= b.start_time
          AND EXISTS (SELECT 1 FROM after a WHERE a.player_id=b.player_id
                      AND a.game_id=b.game_id AND a.prop_type=b.prop_type)) AS live_with_fallback;"
```

Expected exactly: `761|746|52|37`.

So 52 keys were resolving to a live quote; 37 fall back to a genuine pre-start row and 15 (`52 - 37`) drop entirely. `761 - 746 = 15` confirms it.

- [ ] **Step 6: Confirm `reprice` now reads the guarded set**

```bash
npm run lines -- reprice --date 2026-09-12
```

Expected: `re-priced 746 stored line(s); wrote N pick(s) — 0 API credits`.

The line count must be **746**, down from 761. The pick count `N` will differ from the 401 recorded earlier today; record the actual number and attribute the change to the 15 dropped keys plus the 37 re-priced off a pre-start line. **Fewer picks here is the intended outcome, not a regression.** `reprice` makes no API call, so this costs nothing.

- [ ] **Step 7: Confirm the player card did not lose legitimate rows**

The added `JOIN games` must not drop rows it should keep. Compare a player's line count before and after the guard:

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c "
WITH one AS (SELECT player_id FROM market_lines GROUP BY 1 ORDER BY count(*) DESC LIMIT 1)
SELECT (SELECT count(*) FROM (
          SELECT DISTINCT ON (game_id, prop_type) 1 AS x FROM market_lines
          WHERE player_id=(SELECT player_id FROM one)
          ORDER BY game_id, prop_type, is_sharp DESC, fetched_at DESC) a) AS card_lines_before,
       (SELECT count(*) FROM (
          SELECT DISTINCT ON (ml.game_id, ml.prop_type) 1 AS x
          FROM market_lines ml JOIN games g ON g.id=ml.game_id
          WHERE ml.player_id=(SELECT player_id FROM one) AND ml.fetched_at < g.start_time
          ORDER BY ml.game_id, ml.prop_type, ml.is_sharp DESC, ml.fetched_at DESC) b) AS card_lines_after;"
```

Expected: `card_lines_after` is greater than 0 and at most `card_lines_before`. A drop to 0 means the join or the guard is wrong — stop and report. Record both numbers.

- [ ] **Step 8: Commit**

```bash
git add packages/pipeline/src/market/lines.ts packages/db/src/queries/player.ts
git commit -m "Ignore quotes fetched after first pitch when choosing a line

Both readers order by fetched_at DESC, so a live in-game quote won on any
key a late capture touched -- 52 of 761 on today's slate. DISTINCT ON
applies WHERE before picking, so excluding live rows falls back to the
newest pre-start row for free: 37 of the 52 recover a real price and 15
have none and are dropped.

reprice now reads 746 lines instead of 761. Fewer priced props is the
intended outcome: there is no honest price for the 15."
```

---

### Task 3: Correct the known seam that this branch invalidates

**Files:**
- Modify: `CLAUDE.md` (the CLV known-seam bullet)
- Modify: `AGENTS.md` (byte-identical twin of `CLAUDE.md`)

**Interfaces:**
- Consumes: the behaviour built in Tasks 1-2. No code.

**Why this task exists:** the seam bullet added hours earlier (merge `17bf9a3`) states that the guarantee "covers CLV only, not the whole pipeline: live quotes still land in `market_lines`, and `lines reprice` prefers the newest row". Tasks 1-2 make that false. A known-seams entry describing a fixed bug is worse than none — the next reader will design around a hazard that no longer exists, or distrust a path that is now safe.

- [ ] **Step 1: Read the current bullet**

```bash
sed -n '/## Known seams/,/## Open work/p' CLAUDE.md
```

Record it verbatim in your report before editing.

- [ ] **Step 2: Rewrite the bullet in `CLAUDE.md`**

Replace the existing CLV seam bullet — the one beginning `- CLV **reads** (`clv.ts`, `scorecard.ts`) structurally exclude` and running to `...excluded as unverifiable, not proven contaminated.` — with:

```
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
  pitch". Only 22 of the 336 kept CLV rows were captured within an hour of first
  pitch; 153 were 3-7 hours out. "Closing line value" is still a generous label.
```

The split into three bullets is deliberate: the `fetched_at` guard is exact while the `close_captured_at` proxy is not, and collapsing them would imply the weaker of the two applies to both.

- [ ] **Step 3: Apply the identical edit to `AGENTS.md`**

`CLAUDE.md` and `AGENTS.md` are byte-identical copies of the same document. Apply exactly the same replacement so they do not drift.

- [ ] **Step 4: Verify the twins are still identical**

```bash
diff -q CLAUDE.md AGENTS.md && echo "IDENTICAL"
```

Expected: `IDENTICAL` with no diff output.

- [ ] **Step 5: Verify no stale claim survives**

```bash
grep -n "live quotes still land\|prefers the newest row" CLAUDE.md AGENTS.md || echo "CLEAN: no stale claim"
```

Expected: `CLEAN: no stale claim`. Any hit means the old bullet text survived the replacement.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md AGENTS.md
git commit -m "Correct the CLV seam now that live quotes are guarded

The seam bullet said live quotes still land in market_lines and reprice
prefers the newest row. Tasks 1-2 make that false. Splits the entry in
three so the exact fetched_at guard is not conflated with the approximate
close_captured_at proxy, and records the remaining real seam: there is
still no lower bound on capture lead time."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by |
|---|---|
| Skip started games before `getEventOdds` | Task 1, Step 5 |
| "Started" = `start_time <= now()`; NULL is treated as started | Task 1, Step 1 (helper + comment) |
| Guard not placed in `buildGameIndex` | Task 1, Step 1 (helper lives in `lines.ts`) |
| Applies to both `pull` and `capture` | Task 1, Step 7 (`captureClosing` needs no change; both use `fetchLines`) |
| `skippedStarted` on `FetchResult` | Task 1, Steps 2, 4, 6 |
| `pull` must not misreport a started slate | Task 1, Step 8 |
| Read guard on `loadStoredLines` | Task 2, Step 1 |
| Read guard on `getPlayerCard` + added `JOIN games` | Task 2, Step 2 |
| Fallback is free via `DISTINCT ON`; no fallback logic | Task 2, Step 1 (comment) and Step 5 (37 measured) |
| NULL `start_time` excludes | Task 2, Step 1 (comment) |
| No migration / no mutation of existing rows | Global Constraints |
| 271 existing rows left in place | Global Constraints; Task 3 bullet text |
| Expected effect 761 → 746, 52 → 0, 37 / 15 | Task 2, Steps 5-6 |
| 15 dropped keys are correct, not a regression | Task 2, Step 6; Global Constraints |
| Prevention proven with blanked key | Task 1, Step 10 |
| Quota identical before/after | Task 1, Step 12 |
| `npm run typecheck` exits 0 | Task 1 Step 9; Task 2 Step 3 |
| `build:db` + compiled-output check | Task 2, Steps 3-4 |
| Known seam re-stated (no lower bound on lead time) | Task 3, Step 2 |

Task 3 is additive beyond the spec's explicit sections: the spec lists the lead-time gap under "Out of scope" as a *known seam to record*, and Tasks 1-2 falsify a seam bullet currently shipped in `CLAUDE.md`. Leaving it would misdescribe the system.

**Placeholder scan:** no TBDs, no "handle edge cases", no "similar to Task N". Every code step carries complete code; every command step carries an exact command and an expected result, including the measured numbers (761, 746, 52, 37, 15, 271, 15 games, 204 credits) that make the checks falsifiable.

**Type consistency:**
- `startedGameIds(date: string): Promise<Set<number>>` — defined Task 1 Step 1, called Task 1 Step 3. Returns a `Set<number>`; `startedGames.has(gameId)` in Step 5 matches, and `gameId` is `number` (from `gameIndex.get`, `Map<string, number>`).
- `skippedStartedGames` — named identically in `FetchResult` (Step 2), the local counter (Step 4), the `fetchLines` return (Step 6), `PullResult` (Step 7), and `cli.ts` (Step 8). One name throughout; no `skippedStarted`/`skippedStartedGames` drift.
- `loadStoredLines` and `getPlayerCard` keep their existing signatures and returned column names, so `referenceLines`, `priceAndWritePicks`, and the player-card `lineMap` need no changes.
- `captureClosing` destructures only `{ rows }` from `fetchLines`, so widening `FetchResult` cannot break it.

**One ordering dependency:** none between Tasks 1 and 2 — they touch disjoint code paths (write vs read) and can be reviewed independently. Task 3 must run last, since its text asserts that Tasks 1 and 2 have landed.
