# Reprice Skips Started Games Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `lines reprice` price only games that are still bettable, which also stops it deleting captured closing lines.

**Architecture:** `loadStoredLines` gains `AND g.start_time > now()`. Because `priceAndWritePicks` derives its `DELETE` scope from the rows it is handed, an excluded game is never named in the delete — so started games' picks and closes are preserved with no extra code. The `--force` captured-close guard narrows to upcoming games, or it would refuse on slates where repricing is provably harmless.

**Tech Stack:** TypeScript, npm workspaces, `tsx` (pipeline runs from source), Postgres 16 via `docker compose`.

**Spec:** `docs/superpowers/specs/2026-09-13-reprice-skip-started-design.md`

## Global Constraints

- **Odds API quota is 204 of 500 credits. NO TASK MAY CALL THE ODDS API.** Never run `lines pull` or `lines capture`. `npm run lines -- reprice` makes no API call and is the only `lines` command this plan runs.
- **NEVER pass `--force` to `reprice`.** It deletes captured closing lines. No step in this plan needs it.
- **The verification order in Task 1 is a safety property, not a preference.** 2026-09-11 holds the last intact CLV data in this project (157 picks, 157 closes). Its reprice check runs ONLY after the 2026-09-12 check has proven the filter returns 0 rows. Reversing them risks destroying data exactly as the previous incident did.
- **Do not change `MODEL_VERSION`, `K_BF`, `K_PA`, the edge threshold, or the de-vig method.** This is measurement plumbing, not the model.
- **No schema change, no migration.** The pipeline runs from source via `tsx`; no build step needed. (`@mlb-edge/db` is not touched by this plan.)
- **"Started" means `start_time <= now() OR start_time IS NULL`** — the same disposition `startedGameIds` uses. An unverifiable start time is never trusted.

## A note on testing

This repo has **no test runner, no test files, and no lint script** — verified across every `package.json`. Standing one up is not in scope. Verification is `npm run typecheck` plus database checks with exact expected values, all measured against the live database before this plan was written.

## Baseline measured before this work

| measure | 2026-09-11 | 2026-09-12 |
|---|---|---|
| games (non-synthetic) | 15 | 15 |
| of those, started | **15** | **15** |
| of those, started **and** having stored lines | **15** | **15** |
| picks | **157** | **424** |
| picks with a `close_line` | **157** | 0 |
| picks with a `close_line` on an **upcoming** game | **0** | **0** |

Both slates are fully started, so after this change `reprice` must read **0** lines for either. 2026-09-13 has no ingested games.

## Environment prerequisite

```bash
docker compose up -d
```

---

### Task 1: Skip started games, narrow the guard, report the skip

**Files:**
- Modify: `packages/pipeline/src/market/lines.ts` (`loadStoredLines` query; `RepriceResult`; `repriceLines`)
- Modify: `packages/pipeline/src/cli.ts` (the `lines reprice` action)

**Interfaces:**
- Produces: `RepriceResult` gains `startedGamesSkipped: number`. Consumed by the `lines reprice` action in `cli.ts`.
- `repriceLines(date: string, edgeThreshold: number, force?: boolean): Promise<RepriceResult>` — signature unchanged.
- Consumes: the existing `query` import at the top of `lines.ts`.

These three changes ship together on purpose: the filter without the narrowed guard produces false refusals, and the reporting is what explains a zero-line run.

- [ ] **Step 1: Filter started games out of `loadStoredLines`**

In `packages/pipeline/src/market/lines.ts`, in the `loadStoredLines` query, replace:

```sql
     FROM market_lines ml JOIN games g ON g.id = ml.game_id
     WHERE g.game_date = $1
```

with:

```sql
     FROM market_lines ml JOIN games g ON g.id = ml.game_id
     WHERE g.game_date = $1
       -- Only games that are still bettable. This does double duty: reprice
       -- stops writing picks nobody can act on, AND -- because
       -- priceAndWritePicks derives its DELETE scope from the rows it is
       -- handed -- an excluded game is never named in the delete, so its
       -- picks and any captured closing lines survive untouched. That
       -- preservation is load-bearing; do not "optimise" the gameIds
       -- derivation to use the slate's games instead of the returned rows.
       -- NULL start_time is excluded, matching startedGameIds: an
       -- unverifiable start time is never trusted.
       AND g.start_time > now()
```

Leave the existing `AND ml.fetched_at < g.start_time` condition and the `ORDER BY` exactly as they are.

- [ ] **Step 2: Extend `RepriceResult`**

Replace:

```ts
  // Count of this slate's picks with a non-null close_line, checked BEFORE
  // any write. If refused is true, this is what refusing avoided destroying.
  // If refused is false and this is > 0, `force` was passed and repricing
  // just deleted and re-inserted all of this slate's picks, destroying that
  // many rows' close_line/close_odds/close_fair_prob/clv_pct/
  // close_captured_at/result.
  capturedCount: number;
}
```

with:

```ts
  // Count of this slate's picks with a non-null close_line ON AN UPCOMING GAME,
  // checked BEFORE any write. Scoped to upcoming games because those are the
  // only picks reprice can still delete -- a started game's picks are no longer
  // touched at all. Counting the whole slate here would refuse on a fully
  // started slate where repricing is provably harmless, which would train the
  // operator to reach for --force.
  // If refused is true, this is what refusing avoided destroying. If refused is
  // false and this is > 0, `force` was passed and repricing just deleted and
  // re-inserted the upcoming games' picks, destroying that many rows'
  // close_line/close_odds/close_fair_prob/clv_pct/close_captured_at/result.
  capturedCount: number;
  // Distinct games on this slate that HAVE stored market_lines rows and have
  // already started -- i.e. exactly what the loadStoredLines filter excluded,
  // not simply how many games are underway. A game that was never pulled had
  // nothing to skip and is not counted.
  startedGamesSkipped: number;
}
```

- [ ] **Step 3: Narrow the guard and count the skip in `repriceLines`**

Replace the whole body of `repriceLines` (everything from `const capturedCount` to the final `return`):

```ts
  const capturedCount = Number(
    (
      await query<{ n: string }>(
        `SELECT count(*) AS n
         FROM picks pk JOIN games g ON g.id = pk.game_id
         WHERE g.game_date = $1 AND NOT g.is_synthetic AND pk.close_line IS NOT NULL`,
        [date],
      )
    ).rows[0].n,
  );

  if (capturedCount > 0 && !force) {
    return { linesRead: 0, picksWritten: 0, refused: true, capturedCount };
  }

  const rows = await loadStoredLines(date);
  const picksWritten = await priceAndWritePicks(date, rows, edgeThreshold);
  return { linesRead: rows.length, picksWritten, refused: false, capturedCount };
}
```

with:

```ts
  // Scoped to upcoming games: those are the only picks reprice can still
  // delete, so they are the only ones worth refusing over.
  const capturedCount = Number(
    (
      await query<{ n: string }>(
        `SELECT count(*) AS n
         FROM picks pk JOIN games g ON g.id = pk.game_id
         WHERE g.game_date = $1 AND NOT g.is_synthetic
           AND pk.close_line IS NOT NULL
           AND g.start_time > now()`,
        [date],
      )
    ).rows[0].n,
  );

  // What the loadStoredLines filter excluded: games with stored lines that have
  // already started. Computed even when refusing, so the CLI can always explain
  // itself.
  const startedGamesSkipped = Number(
    (
      await query<{ n: string }>(
        `SELECT count(DISTINCT ml.game_id) AS n
         FROM market_lines ml JOIN games g ON g.id = ml.game_id
         WHERE g.game_date = $1 AND NOT g.is_synthetic
           AND (g.start_time <= now() OR g.start_time IS NULL)`,
        [date],
      )
    ).rows[0].n,
  );

  if (capturedCount > 0 && !force) {
    return { linesRead: 0, picksWritten: 0, refused: true, capturedCount, startedGamesSkipped };
  }

  const rows = await loadStoredLines(date);
  const picksWritten = await priceAndWritePicks(date, rows, edgeThreshold);
  return { linesRead: rows.length, picksWritten, refused: false, capturedCount, startedGamesSkipped };
}
```

- [ ] **Step 4: Report the skip in the CLI**

In `packages/pipeline/src/cli.ts`, in the `lines reprice` action, replace:

```ts
    const destroyed = r.capturedCount > 0 ? `; destroyed ${r.capturedCount} captured closing line(s)` : '';
    console.log(`re-priced ${r.linesRead} stored line(s); wrote ${r.picksWritten} pick(s) — 0 API credits${destroyed}`);
```

with:

```ts
    const destroyed = r.capturedCount > 0 ? `; destroyed ${r.capturedCount} captured closing line(s)` : '';
    const skipped = r.startedGamesSkipped > 0 ? `; skipped ${r.startedGamesSkipped} started game(s)` : '';
    console.log(
      `re-priced ${r.linesRead} stored line(s); wrote ${r.picksWritten} pick(s) — 0 API credits${skipped}${destroyed}`,
    );
    if (r.linesRead === 0 && r.startedGamesSkipped > 0) {
      console.log(
        `Hint: every game with stored lines on ${o.date} has started; nothing is still bettable, ` +
          'and existing picks were left untouched.',
      );
    }
```

Leave the `if (r.refused)` block above it exactly as it is.

The hint's condition is sound: an upcoming game with any stored line always yields rows, because `fetched_at <= now() < start_time` satisfies the other guard. So `linesRead === 0` with skips present means every game that had lines has started.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

Expected: exits 0. A type error on `startedGamesSkipped` means Step 2 or 3 was skipped.

- [ ] **Step 6: Record the before-counts**

Capture these now so the after-comparison is exact:

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT g.game_date, count(*) AS picks, count(pk.close_line) AS with_close
   FROM picks pk JOIN games g ON g.id = pk.game_id WHERE NOT g.is_synthetic
   GROUP BY 1 ORDER BY 1;"
```

Expected exactly:
```
2026-09-11|157|157
2026-09-12|424|0
```

If these differ, stop and report — the rest of this task's expectations are built on them.

- [ ] **Step 7: Reprice 2026-09-12 — the SAFE slate, and it must go first**

This slate's picks carry **no** closing lines, so even a broken filter loses nothing but pick churn. That is exactly why it is the first live check.

```bash
npm run lines -- reprice --date 2026-09-12
```

Expected output:
```
re-priced 0 stored line(s); wrote 0 pick(s) — 0 API credits; skipped 15 started game(s)
Hint: every game with stored lines on 2026-09-12 has started; nothing is still bettable, and existing picks were left untouched.
```

Then confirm nothing was deleted:

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -c \
  "SELECT count(*) FROM picks pk JOIN games g ON g.id = pk.game_id
   WHERE g.game_date = '2026-09-12';"
```

Expected: **424**, unchanged. A lower number means the delete still ran and the preservation property is broken — stop immediately and do NOT proceed to Step 8.

- [ ] **Step 8: Reprice 2026-09-11 — ONLY if Step 7 read 0 lines**

**Gate:** proceed only if Step 7 printed `re-priced 0 stored line(s)` and the pick count stayed at 424. If either failed, stop. 2026-09-11 holds the project's last intact CLV data, and a broken filter would delete it.

```bash
npm run lines -- reprice --date 2026-09-11
```

Expected output — note it must **not** refuse, because the narrowed guard counts 0 closes on upcoming games:
```
re-priced 0 stored line(s); wrote 0 pick(s) — 0 API credits; skipped 15 started game(s)
Hint: every game with stored lines on 2026-09-11 has started; nothing is still bettable, and existing picks were left untouched.
```

Then confirm the CLV data survived:

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT count(*) AS picks, count(close_line) AS with_close, count(close_captured_at) AS stamped
   FROM picks pk JOIN games g ON g.id = pk.game_id WHERE g.game_date = '2026-09-11';"
```

Expected exactly: `157|157|157`.

- [ ] **Step 9: Prove the narrowed guard by SQL**

Triggering a true refusal would need closes captured on an upcoming game — ~120 credits and no ingested slate to do it on. Prove it by query instead:

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT g.game_date,
          count(*) FILTER (WHERE pk.close_line IS NOT NULL) AS closes_whole_slate,
          count(*) FILTER (WHERE pk.close_line IS NOT NULL AND g.start_time > now()) AS closes_upcoming
   FROM picks pk JOIN games g ON g.id = pk.game_id WHERE NOT g.is_synthetic
   GROUP BY 1 ORDER BY 1;"
```

Expected exactly:
```
2026-09-11|157|0
2026-09-12|0|0
```

`closes_upcoming = 0` on both is why neither run refused in Steps 7-8. The `2026-09-11|157|0` row is the whole point of the narrowing: the **old** guard would have counted 157 and refused a command that provably touches nothing.

- [ ] **Step 10: Confirm `npm run clv` is unchanged**

The CLV sample must be untouched by everything above:

```bash
npm run clv
```

Expected: `strikeouts 3`, `total_bases 30` (n=33 total), and the `124 row(s) excluded` line — identical to before this task.

- [ ] **Step 11: Confirm no credits were spent**

```bash
set -a; . ./.env; set +a
curl -s -D - -o /dev/null "https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}" | grep -i x-requests-remaining
```

Expected: **204**. `reprice` makes no API call; the `/sports` endpoint is free. Do not print the API key.

- [ ] **Step 12: Commit**

```bash
git add packages/pipeline/src/market/lines.ts packages/pipeline/src/cli.ts
git commit -m "Price only games that are still bettable in reprice

reprice was the one lines command that ignored game start: it wrote picks
on games already underway (259 of 424 on 2026-09-12) and deleted their
captured closing lines -- the mechanism that destroyed that slate's 343
closes and took the CLV sample from 336 rows to 33.

Filtering loadStoredLines preserves started games' picks for free:
priceAndWritePicks derives its DELETE scope from the rows it is handed,
so an excluded game is never named.

The --force captured-close guard narrows to upcoming games. Scoped to the
whole slate it would have refused on 2026-09-11 -- 157 closes, every game
finished -- where repricing provably touches nothing, which teaches the
operator to reach for --force."
```

---

### Task 2: Correct the `reprice` seam in the docs

**Files:**
- Modify: `CLAUDE.md` (the `lines reprice` known-seam bullet)
- Modify: `AGENTS.md` (byte-identical twin)

**Interfaces:**
- Consumes: the behaviour built in Task 1. No code.

**Why this task exists:** the seam bullet added by the previous branch states that `reprice` "does not check game start at all, only whether a closing line was captured." Task 1 makes that false. A known-seams entry describing a fixed bug is worse than none — it sends the next reader to design around a hazard that no longer exists.

- [ ] **Step 1: Read the current bullet**

```bash
sed -n '/## Known seams/,/## Open work/p' CLAUDE.md
```

Record it verbatim in your report before editing.

- [ ] **Step 2: Replace the bullet in `CLAUDE.md`**

Replace the entire bullet beginning `- \`lines reprice\` still deletes and re-inserts every pick on the slate` and running to its end (`...described above.`) with:

```
- `lines reprice` prices only games that have not started
  (`loadStoredLines` filters `g.start_time > now()`), so it writes no picks on
  games already underway. Started games' picks — and any captured closing lines
  on them — are preserved because `priceAndWritePicks` derives its
  `DELETE FROM picks WHERE game_id = ANY(...)` scope from the rows it is handed,
  and an excluded game never appears there. For upcoming games it still deletes
  and re-inserts, so it still refuses by default when an upcoming game already
  has a captured closing line; `--force` overrides and destroys them. All three
  `lines` commands now agree: none of them touch a game that has started.
```

- [ ] **Step 3: Apply the identical edit to `AGENTS.md`**

`CLAUDE.md` and `AGENTS.md` are byte-identical copies. Apply exactly the same replacement so they do not drift.

- [ ] **Step 4: Verify the twins match**

```bash
diff -q CLAUDE.md AGENTS.md && echo "IDENTICAL"
```

Expected: `IDENTICAL`, no diff output.

- [ ] **Step 5: Verify no stale claim survives**

```bash
grep -n "does not check game start" CLAUDE.md AGENTS.md || echo "CLEAN: no stale claim"
```

Expected: `CLEAN: no stale claim`. A hit means the old bullet text survived.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md AGENTS.md
git commit -m "Correct the reprice seam now that it skips started games

The bullet said reprice does not check game start at all. Task 1 makes
that false, and a known-seam entry describing a fixed bug sends the next
reader to design around a hazard that no longer exists."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by |
|---|---|
| `loadStoredLines` gains `AND g.start_time > now()` | Task 1, Step 1 |
| NULL `start_time` excluded, matching other guards | Task 1, Step 1 (comment) |
| Preservation is automatic via row-derived `DELETE` scope | Task 1, Step 1 (comment); proven Steps 7-8 |
| Preservation proven by test, not assumed | Task 1, Steps 7 and 8 (pick counts before/after) |
| `--force` guard narrows to upcoming games | Task 1, Steps 2-3 |
| Guard narrowing prevents false refusal on 2026-09-11 | Task 1, Step 9 |
| `RepriceResult.startedGamesSkipped` | Task 1, Step 2 |
| Counts games *with stored lines* that started, not all started games | Task 1, Step 2 (comment) and Step 3 (SQL uses `market_lines` join) |
| CLI explains a zero-line run | Task 1, Step 4 |
| Verification order 9/12 before 9/11 is a safety property | Global Constraints; Task 1, Steps 7-8 (explicit gate) |
| Guard proven by SQL, not by triggering | Task 1, Step 9 |
| `npm run typecheck` exits 0 | Task 1, Step 5 |
| Quota remains 204 | Task 1, Step 11 |
| Docs seam rewritten | Task 2 |
| No `MODEL_VERSION`/`K_BF`/`K_PA`/threshold/de-vig change | Global Constraints |
| No schema change, no migration | Global Constraints |
| `--force` retained | Task 1, Step 3 (refusal path kept) |

No spec requirement is without a task. Step 10 (`npm run clv` unchanged) is additive beyond the spec: the previous incident was detected only because someone re-ran `clv`, so confirming the CLV sample is untouched is cheap insurance on a plan that runs `reprice` twice.

**Placeholder scan:** no TBDs, no "handle edge cases", no "similar to Task N". Every code step carries complete code; every command step carries an exact command and an exact expected result, including the measured numbers (157, 424, 15, 0, 33, 204) that make the checks falsifiable.

**Type consistency:**
- `startedGamesSkipped` — declared in `RepriceResult` (Step 2), computed in `repriceLines` (Step 3), returned on **both** the refusal and success paths (Step 3), consumed twice in `cli.ts` (Step 4). One spelling throughout.
- `capturedCount` keeps its name and type (`number`); only the SQL behind it narrows, so the CLI's existing refusal message needs no change.
- `repriceLines(date, edgeThreshold, force?)` keeps its signature, so the CLI call site is unchanged.
- `loadStoredLines` still returns `LineRow[]`; `priceAndWritePicks` is untouched and needs no change.

**One ordering dependency:** Task 1 must precede Task 2, since Task 2's text asserts Task 1 has landed. Within Task 1, Step 7 must precede Step 8 — that is a data-safety gate, not a convenience.
