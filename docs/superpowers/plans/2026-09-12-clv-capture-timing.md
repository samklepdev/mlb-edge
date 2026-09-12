# CLV Capture Timing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `lines capture` recording live in-game odds as closing lines, and exclude the 164 already-contaminated CLV rows from every reported figure.

**Architecture:** `games.start_time` already exists and is 100% populated but is read by nothing. A new `picks.close_captured_at` column records when a close was taken; a one-time backfill approximates it for history from `max(market_lines.fetched_at)` per slate. `captureClosing` then refuses to write a close after first pitch (and skips the API call entirely when the whole slate has started), and the two CLV read sites filter on `close_captured_at < start_time`.

**Tech Stack:** TypeScript, npm workspaces, `tsx` (pipeline runs from source), Postgres 16 via `docker compose`.

**Spec:** `docs/superpowers/specs/2026-09-12-clv-capture-timing-design.md`

## Global Constraints

- **`@mlb-edge/db` compiles to `dist/` and runs from there.** After ANY edit under `packages/db/src`, run `npm run build:db` or the change is invisible at runtime. The CLV queries in Task 2 live in this package — this is the most common false-pass in this repo.
- **Odds API quota is 204 of 500 credits and a full fetch costs ~120. NO TASK MAY CALL THE ODDS API.** Every verification below either spends zero credits or explicitly proves zero were spent. Never run `lines capture` or `lines pull` against a date with an upcoming game.
- **`npm run db:migrate` is not automated** — it mutates data. Task 1 runs it explicitly. Migrations are tracked in `schema_migrations`, applied once, in filename sort order, inside a transaction.
- **Do not change `MODEL_VERSION`, `K_BF`, `K_PA`, the edge threshold, or the de-vig method.** This is measurement plumbing, not the model.
- **No dashboard changes.** Surfacing first pitch is CLI-only.
- **Reported CLV `n` will fall from 500 to 336. That is the deliverable, not a regression** — say so in the commit message rather than burying it.

## A note on testing

This repo has **no test runner, no test files, and no lint script** — verified across every `package.json`. Standing one up is not in scope. Verification is `npm run typecheck` plus database checks with exact expected values, matching the convention of previous plans here. Every expected number below was measured against the live database **before** any code was written, so the checks are falsifiable rather than self-confirming.

## Baseline measured before this work

| measure | baseline |
|---|---|
| non-synthetic picks with a `close_line` | **500** |
| of those, captured post-start (contaminated) | **164** |
| of those, captured pre-start (clean) | **336** |
| synthetic demo picks with a `close_line` | 160 (must stay untouched) |
| `npm run clv` — hits | n 154, avg −0.020 |
| `npm run clv` — home_runs | n 42, avg 0.001 |
| `npm run clv` — strikeouts | n 33, avg −0.012 |
| `npm run clv` — total_bases | n 271, avg 0.004 |

## Environment prerequisite

```bash
docker compose up -d
```

---

### Task 1: Migration and historical backfill

**Files:**
- Create: `packages/pipeline/migrations/008_pick_close_captured_at.sql`

**Interfaces:**
- Produces: column `picks.close_captured_at TIMESTAMPTZ` (nullable). Tasks 2 and 3 both read and write it. No TypeScript interface changes in this task.

- [ ] **Step 1: Write the migration**

Create `packages/pipeline/migrations/008_pick_close_captured_at.sql`:

```sql
-- `lines capture` had no knowledge of first pitch, so running it after a game
-- started recorded LIVE IN-GAME odds into close_line and clv_pct as though they
-- were closing prices. 164 of 500 CLV rows (33%) were contaminated this way,
-- including 124 of the 157 rows behind the +0.265% headline forward-test figure.
--
-- picks had no record of WHEN a close was taken (created_at is when the PICK was
-- written), so no read-time filter could tell a good historical capture from a
-- bad one. This column supplies that, and Task 3's guard keeps it honest going
-- forward.
ALTER TABLE picks ADD COLUMN IF NOT EXISTS close_captured_at TIMESTAMPTZ;

-- Backfill: approximate each existing capture with the LAST market_lines fetch
-- for that slate. This is an APPROXIMATION and is deliberately conservative --
-- using the latest fetch can only make a capture look later than it really was,
-- so it over-excludes rather than over-trusts. For a measurement tool that is
-- the correct direction to err.
--
-- The demo seed is untouched by construction: the sentinel game (2099-01-01)
-- has zero market_lines rows, so this join matches nothing for it and its 160
-- picks keep a NULL close_captured_at -- which the CLV filter treats as "not
-- verifiable" rather than "trusted".
UPDATE picks pk
SET close_captured_at = sub.last_fetch
FROM games g,
     (SELECT g2.game_date, max(ml.fetched_at) AS last_fetch
      FROM market_lines ml JOIN games g2 ON g2.id = ml.game_id
      GROUP BY g2.game_date) sub
WHERE g.id = pk.game_id
  AND sub.game_date = g.game_date
  AND pk.close_line IS NOT NULL
  AND pk.close_captured_at IS NULL;
```

- [ ] **Step 2: Apply the migration**

```bash
npm run db:migrate
```

Expected: `+ applied 008_pick_close_captured_at.sql` followed by `migrations up to date`. If it says `= skip`, the file name collides with an already-applied migration — stop and investigate.

- [ ] **Step 3: Verify the column exists and the backfill count is exact**

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT count(*) FILTER (WHERE pk.close_captured_at IS NOT NULL) AS stamped,
          count(*) FILTER (WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic) AS should_be_stamped,
          count(*) FILTER (WHERE pk.close_line IS NOT NULL AND g.is_synthetic) AS synthetic_left_null
   FROM picks pk JOIN games g ON g.id = pk.game_id;"
```

Expected exactly: `500|500|160`.

`stamped` must equal `should_be_stamped` (every real close got a timestamp), and `synthetic_left_null` must be **160** — the demo picks must NOT have been stamped. If synthetic rows got stamped, the sentinel date acquired `market_lines` rows and the backfill's assumption is broken; stop and report.

- [ ] **Step 4: Verify the clean/contaminated split**

This is the number the whole plan turns on:

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT count(*) FILTER (WHERE pk.close_captured_at <  g.start_time) AS kept,
          count(*) FILTER (WHERE pk.close_captured_at >= g.start_time) AS excluded,
          count(*) AS total
   FROM picks pk JOIN games g ON g.id = pk.game_id
   WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic;"
```

Expected exactly: `336|164|500`.

- [ ] **Step 5: Verify the per-slate breakdown matches the spec's evidence**

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT g.game_date,
          count(*) FILTER (WHERE pk.close_captured_at <  g.start_time) AS clean,
          count(*) FILTER (WHERE pk.close_captured_at >= g.start_time) AS contaminated
   FROM picks pk JOIN games g ON g.id = pk.game_id
   WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic
   GROUP BY 1 ORDER BY 1;"
```

Expected exactly:
```
2026-09-11|33|124
2026-09-12|303|40
```

- [ ] **Step 6: Commit**

```bash
git add packages/pipeline/migrations/008_pick_close_captured_at.sql
git commit -m "Record when a closing line was captured

picks had no record of when a close was taken, so nothing could tell a
good historical capture from one that recorded live in-game odds.
Backfills history from the last market_lines fetch per slate -- an
approximation, deliberately conservative: it can only make a capture look
later than it was, so it over-excludes rather than over-trusts."
```

---

### Task 2: Filter contaminated rows out of every CLV readout

**Files:**
- Modify: `packages/db/src/queries/clv.ts` (the `WHERE` clause in `clvByProp`)
- Modify: `packages/db/src/queries/scorecard.ts:12-16` (three `FILTER` clauses in `getScorecard`)

**Interfaces:**
- Consumes: `picks.close_captured_at` from Task 1.
- Produces: no signature changes. `clvByProp` and `getScorecard` keep their exact return types (`ClvRow[]` and `Scorecard`); only the rows they count change.

These are the **only** two sites that read `close_line` or `clv_pct` — verified by grep across `packages/` and `apps/`. Do not go looking for a third.

- [ ] **Step 1: Filter `clvByProp`**

In `packages/db/src/queries/clv.ts`, replace:

```ts
    FROM picks pk JOIN games g ON g.id = pk.game_id
    WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic
    GROUP BY prop_type
```

with:

```ts
    FROM picks pk JOIN games g ON g.id = pk.game_id
    WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic
      -- A close taken after first pitch is a LIVE in-game price, not a closing
      -- price. Structural rather than incidental: the guarantee holds even if a
      -- future capture runs at the wrong time. NULL means "not verifiable"
      -- (pre-backfill or demo data) and is excluded for the same reason.
      AND pk.close_captured_at IS NOT NULL
      AND pk.close_captured_at < g.start_time
    GROUP BY prop_type
```

- [ ] **Step 2: Filter `getScorecard`**

In `packages/db/src/queries/scorecard.ts`, the three CLV aggregates each repeat the same condition. Replace lines 12-16:

```ts
        count(*) FILTER (WHERE pk.result IS NOT NULL AND NOT g.is_synthetic)     AS settled,
        count(*) FILTER (WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic) AS with_close,
        (avg(pk.clv_pct) FILTER (WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic))::float8 AS avg_clv,
        count(*) FILTER (WHERE pk.result IS NOT NULL AND g.is_synthetic)         AS synthetic_settled,
        count(DISTINCT pk.game_id) FILTER (WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic) AS clv_games
```

with:

```ts
        count(*) FILTER (WHERE pk.result IS NOT NULL AND NOT g.is_synthetic)     AS settled,
        -- A close taken after first pitch is a LIVE in-game price, not a closing
        -- price; NULL means "not verifiable" (pre-backfill or demo data). Both
        -- are excluded from every CLV aggregate below. `settled` and
        -- `synthetic_settled` are deliberately NOT filtered -- they count
        -- graded outcomes, which capture timing does not affect.
        count(*) FILTER (WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic
                           AND pk.close_captured_at IS NOT NULL
                           AND pk.close_captured_at < g.start_time) AS with_close,
        (avg(pk.clv_pct) FILTER (WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic
                                   AND pk.close_captured_at IS NOT NULL
                                   AND pk.close_captured_at < g.start_time))::float8 AS avg_clv,
        count(*) FILTER (WHERE pk.result IS NOT NULL AND g.is_synthetic)         AS synthetic_settled,
        count(DISTINCT pk.game_id) FILTER (WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic
                                             AND pk.close_captured_at IS NOT NULL
                                             AND pk.close_captured_at < g.start_time) AS clv_games
```

Leave `settled` and `synthetic_settled` exactly as they are. They count graded results, not closes — filtering them would silently change the settled-pick count and the demo-notice logic that depends on it.

- [ ] **Step 2a: Typecheck**

Run: `npm run typecheck`

Expected: exits 0. (`npm run typecheck` runs `build:db` first, so this also compiles the package.)

- [ ] **Step 3: Confirm the compiled output carries the filter**

`@mlb-edge/db` runs from `dist/`, so this is mandatory:

```bash
grep -c "close_captured_at" packages/db/dist/queries/clv.js packages/db/dist/queries/scorecard.js
```

Expected: `clv.js` reports **2** and `scorecard.js` reports **6** (two lines per aggregate × three aggregates). A `0` for either means the build did not pick up the edit and every check below is meaningless.

- [ ] **Step 4: Verify the CLV report shows the clean figures**

```bash
npm run clv
```

Expected exactly — compare every row against the baseline:

| prop | before (n, avg) | after (n, avg) |
|---|---|---|
| hits | 154, −0.020 | **126, −0.007** |
| home_runs | 42, 0.001 | **42, 0.001** (unchanged — every HR close was already clean) |
| strikeouts | 33, −0.012 | **18, −0.015** |
| total_bases | 271, 0.004 | **150, 0.002** |

Total n falls 500 → **336**. `home_runs` staying at exactly 42 is a useful control: it proves the filter is discriminating by capture time and not just deleting rows indiscriminately.

- [ ] **Step 5: Verify the dashboard scorecard agrees**

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT count(*) FILTER (WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic
                             AND pk.close_captured_at IS NOT NULL
                             AND pk.close_captured_at < g.start_time) AS with_close,
          round((avg(pk.clv_pct) FILTER (WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic
                                           AND pk.close_captured_at IS NOT NULL
                                           AND pk.close_captured_at < g.start_time))::numeric, 4) AS avg_clv
   FROM picks pk JOIN games g ON g.id = pk.game_id;"
```

Expected: `336|-0.0023`. This is the figure the dashboard's "Avg closing line value" readout will now show, down from −0.0085.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/queries/clv.ts packages/db/src/queries/scorecard.ts
git commit -m "Exclude post-first-pitch captures from CLV

A close taken after first pitch is a live in-game price, not a closing
price. 164 of 500 CLV rows were contaminated this way, and the distortion
ran in BOTH directions (-5.47% on one slate, +0.37% on the other), so it
was noise rather than a correctable bias.

Reported n drops 500 -> 336 and avg CLV moves -0.0085 -> -0.0023. The
smaller, honest sample is the point. The +0.265% figure previously
carried as the forward-test result does not survive: 124 of its 157 rows
were captured after first pitch."
```

---

### Task 3: Make `lines capture` first-pitch aware

**Files:**
- Modify: `packages/pipeline/src/market/lines.ts` (`captureClosing`, and a new exported `CaptureResult` interface)
- Modify: `packages/pipeline/src/cli.ts` (the `lines capture` action, plus a small `fmtUtc` helper)

**Interfaces:**
- Consumes: `picks.close_captured_at` from Task 1.
- Produces:
  - `export interface CaptureResult { updated: number; skipped: number; gamesStarted: number; nextFirstPitch: Date | null; lastFirstPitch: Date | null; fetched: boolean }` — exported from `market/lines.ts`.
  - `captureClosing(date: string, opts: PullOptions): Promise<CaptureResult>` — **return type changes from `Promise<number>`**. Its only caller is the `lines capture` action in `cli.ts`, updated in Step 3.

- [ ] **Step 1: Replace `captureClosing`**

In `packages/pipeline/src/market/lines.ts`, replace the whole of `captureClosing`:

```ts
export async function captureClosing(date: string, opts: PullOptions): Promise<number> {
  const { rows } = await fetchLines(date, opts);
  await storeLines(rows);
  const ref = referenceLines(rows);

  const openPicks = (
    await query<{ id: number; player_id: number; game_id: number; prop_type: string; side: 'over' | 'under' }>(
      `SELECT pk.id, pk.player_id, pk.game_id, pk.prop_type, pk.side
       FROM picks pk JOIN games g ON g.id = pk.game_id
       WHERE g.game_date = $1`,
      [date],
    )
  ).rows;

  let updated = 0;
  await withTx(async (c) => {
    for (const pk of openPicks) {
      const r = ref.get(key(pk.player_id, pk.game_id, pk.prop_type));
      if (!r) continue;
      const { fairOver, fairUnder } = deVig(r.overOdds, r.underOdds);
      const closeFair = pk.side === 'over' ? fairOver : fairUnder;
      const closeOdds = pk.side === 'over' ? r.overOdds : r.underOdds;
      await c.query(
        `UPDATE picks
         SET close_line = $1, close_odds = $2, close_fair_prob = $3,
             clv_pct = $3 - pick_fair_prob
         WHERE id = $4`,
        [r.line, closeOdds, closeFair.toFixed(4), pk.id],
      );
      updated++;
    }
  });
  return updated;
}
```

with:

```ts
export interface CaptureResult {
  updated: number;
  skipped: number;
  gamesStarted: number;
  nextFirstPitch: Date | null;
  lastFirstPitch: Date | null;
  fetched: boolean;
}

// Capture closing lines, but only for games that have not started. A price
// quoted after first pitch is a LIVE in-game price: recording it as a "closing"
// line is what contaminated 164 of the first 500 CLV rows.
export async function captureClosing(date: string, opts: PullOptions): Promise<CaptureResult> {
  // Slate timing BEFORE any network call. If nothing is upcoming there is no
  // closing market left to capture, and a full fetch costs ~120 credits against
  // a 500/month free tier -- so this early exit is the difference between
  // spending 120 credits and spending 0.
  const timing = (
    await query<{ upcoming: string; started: string; next_start: Date | null; last_start: Date | null }>(
      `SELECT count(*) FILTER (WHERE g.start_time >  now()) AS upcoming,
              count(*) FILTER (WHERE g.start_time <= now()) AS started,
              min(g.start_time) FILTER (WHERE g.start_time > now()) AS next_start,
              max(g.start_time) AS last_start
       FROM games g
       WHERE g.game_date = $1 AND NOT g.is_synthetic`,
      [date],
    )
  ).rows[0];

  const upcoming = Number(timing.upcoming);
  const gamesStarted = Number(timing.started);

  const skipped = Number(
    (
      await query<{ n: string }>(
        `SELECT count(*) AS n
         FROM picks pk JOIN games g ON g.id = pk.game_id
         WHERE g.game_date = $1 AND g.start_time <= now()`,
        [date],
      )
    ).rows[0].n,
  );

  if (upcoming === 0) {
    return {
      updated: 0, skipped, gamesStarted,
      nextFirstPitch: null, lastFirstPitch: timing.last_start, fetched: false,
    };
  }

  const { rows } = await fetchLines(date, opts);
  await storeLines(rows);
  const ref = referenceLines(rows);

  // `g.start_time > now()` is the guard: a started game's picks are never
  // written. Wall-clock at capture time, so a rain-delayed game counts as
  // started -- correct, because its market is no longer a closing market either.
  const openPicks = (
    await query<{ id: number; player_id: number; game_id: number; prop_type: string; side: 'over' | 'under' }>(
      `SELECT pk.id, pk.player_id, pk.game_id, pk.prop_type, pk.side
       FROM picks pk JOIN games g ON g.id = pk.game_id
       WHERE g.game_date = $1 AND g.start_time > now()`,
      [date],
    )
  ).rows;

  let updated = 0;
  await withTx(async (c) => {
    for (const pk of openPicks) {
      const r = ref.get(key(pk.player_id, pk.game_id, pk.prop_type));
      if (!r) continue;
      const { fairOver, fairUnder } = deVig(r.overOdds, r.underOdds);
      const closeFair = pk.side === 'over' ? fairOver : fairUnder;
      const closeOdds = pk.side === 'over' ? r.overOdds : r.underOdds;
      await c.query(
        `UPDATE picks
         SET close_line = $1, close_odds = $2, close_fair_prob = $3,
             clv_pct = $3 - pick_fair_prob, close_captured_at = now()
         WHERE id = $4`,
        [r.line, closeOdds, closeFair.toFixed(4), pk.id],
      );
      updated++;
    }
  });

  return {
    updated, skipped, gamesStarted,
    nextFirstPitch: timing.next_start, lastFirstPitch: timing.last_start, fetched: true,
  };
}
```

Note `close_captured_at = now()` in the `UPDATE` — without it Task 2's filter would exclude every newly captured row, and CLV would silently go to zero.

- [ ] **Step 2: Add the UTC formatting helper**

In `packages/pipeline/src/cli.ts`, add immediately above the existing `pullOptions` function (around line 159):

```ts
// Game times are stored as timestamptz; report them in UTC so the output does
// not silently change meaning with the operator's local timezone.
function fmtUtc(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}
```

- [ ] **Step 3: Update the `lines capture` action**

In `packages/pipeline/src/cli.ts`, replace:

```ts
  .action(async (o: { date: string; books: string; sharp: string; regions: string; edge: string }) => {
    const n = await captureClosing(o.date, pullOptions(o));
    console.log(`updated closing line + CLV on ${n} pick(s) for ${o.date}`);
  });
```

with:

```ts
  .action(async (o: { date: string; books: string; sharp: string; regions: string; edge: string }) => {
    const r = await captureClosing(o.date, pullOptions(o));
    if (!r.fetched) {
      console.log(
        `no upcoming games for ${o.date} — all ${r.gamesStarted} game(s) have started; ` +
          `skipped ${r.skipped} pick(s), 0 API credits spent`,
      );
      return;
    }
    console.log(
      `captured ${r.updated} pick(s)` +
        (r.skipped > 0 ? `; skipped ${r.skipped} on ${r.gamesStarted} game(s) already started` : ''),
    );
    if (r.nextFirstPitch != null && r.lastFirstPitch != null) {
      const mins = Math.round((r.nextFirstPitch.getTime() - Date.now()) / 60000);
      console.log(`next first pitch ${fmtUtc(r.nextFirstPitch)} (in ${mins}m) · last ${fmtUtc(r.lastFirstPitch)}`);
    }
  });
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`

Expected: exits 0. A type error at the `captureClosing` call site means Step 3 was skipped — the return type changed from `number` to `CaptureResult`.

- [ ] **Step 5: Prove the zero-credit early exit, spending zero credits**

`2026-09-11` is a fully completed slate, so it exercises the early-exit path with no network call. Record the quota, run capture, record it again:

```bash
set -a; . ./.env; set +a
curl -s -D - -o /dev/null "https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}" | grep -i x-requests-remaining
npm run lines -- capture --date 2026-09-11
curl -s -D - -o /dev/null "https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}" | grep -i x-requests-remaining
```

Expected output from the capture command:
```
no upcoming games for 2026-09-11 — all 15 game(s) have started; skipped 157 pick(s), 0 API credits spent
```

The game count comes from that slate's schedule; the pick count must be **157**. Critically, `x-requests-remaining` must be **identical** before and after. The `/sports` endpoint is free and does not itself consume quota. Do not print the API key.

- [ ] **Step 6: Confirm no historical row was mutated**

The run above must have been a pure read:

```bash
docker compose exec -T db psql -U mlb -d mlb_edge -At -F'|' -c \
  "SELECT count(*) FILTER (WHERE pk.close_captured_at <  g.start_time) AS kept,
          count(*) FILTER (WHERE pk.close_captured_at >= g.start_time) AS excluded
   FROM picks pk JOIN games g ON g.id = pk.game_id
   WHERE pk.close_line IS NOT NULL AND NOT g.is_synthetic;"
```

Expected: still exactly `336|164`, unchanged from Task 1 Step 4. If `excluded` grew, the early exit did not fire and a post-start capture was written.

- [ ] **Step 7: Commit**

```bash
git add packages/pipeline/src/market/lines.ts packages/pipeline/src/cli.ts
git commit -m "Refuse to capture a closing line after first pitch

captureClosing had no knowledge of game times, so running it late
recorded live in-game odds as closing prices. It now skips picks whose
game has started, stamps close_captured_at on the ones it writes, and
exits before the API call entirely when nothing on the slate is upcoming
-- which costs 0 credits instead of ~120.

Also reports the remaining capture window, since knowing first pitch is
what makes the timing decision possible at all."
```

---

### Task 4: Document the capture window in the operator docs

**Files:**
- Modify: `HANDOFF.md` (the command table / pipeline-order section)
- Modify: `CLAUDE.md` (the pipeline-order line for `lines capture`)

**Interfaces:**
- Consumes: the behaviour built in Tasks 1-3. No code.

**Why this task exists:** `CLAUDE.md`'s pipeline-order line describes `lines capture` as "closing lines → CLV" with no mention of timing. `HANDOFF.md:77` already carries a `# before first pitch` comment on the example command — so the rule was *stated but never enforced*, which is exactly how 33% of rows got contaminated. This task makes the docs match the now-enforced behaviour and records the contamination so the next reader does not trust old CLV numbers.

**Verified before writing this task:** the `+0.265%` figure does **not** appear anywhere in `CLAUDE.md`, `HANDOFF.md`, or `docs/` — it lived only in the gitignored `.superpowers/sdd/progress.md`. There is therefore no stale published figure to retract; the `CLAUDE.md` bullet below documents the new invariant rather than correcting an existing claim.

- [ ] **Step 1: Fix the pipeline-order description in `CLAUDE.md`**

In `CLAUDE.md`, in the "Pipeline order" section, replace:

```
`lines capture` (closing lines → CLV)
```

with:

```
`lines capture` (closing lines → CLV; **must run BEFORE first pitch** — it
skips started games, because a price quoted after first pitch is a live
in-game price, not a closing one)
```

- [ ] **Step 2: Record the contamination as a known seam in `CLAUDE.md`**

Still in `CLAUDE.md`, under "Known seams", add this bullet:

```
- CLV rows captured after first pitch are excluded structurally
  (`picks.close_captured_at < games.start_time`). Historical values are
  approximated from `max(market_lines.fetched_at)` per slate — conservative, but
  estimates. Any CLV figure recorded before 2026-09-12 is contaminated: 164 of
  the first 500 rows were live in-game prices, including 124 of the 157 behind
  the old "+0.265%" result.
```

- [ ] **Step 3: Update the `HANDOFF.md` command table**

In `HANDOFF.md`, find the `lines capture` row of the command table and append to its description:

```
 — run before first pitch; skips started games and spends 0 credits if the whole slate has started
```

- [ ] **Step 4: Verify both docs now state the timing requirement**

```bash
grep -n "first pitch" CLAUDE.md HANDOFF.md
```

Expected: at least three hits — the new `CLAUDE.md` pipeline-order text (Step 1), the new `CLAUDE.md` known-seam bullet (Step 2), the new `HANDOFF.md` table text (Step 3), plus the pre-existing `HANDOFF.md:77` comment. The rule must appear in the pipeline-order description, not only in an example command's trailing comment — that placement is why it was missed.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md HANDOFF.md
git commit -m "Document the capture window in the pipeline order

HANDOFF.md already said 'before first pitch' -- but only as a trailing
comment on an example command, so the rule was stated and never enforced.
It now appears in the pipeline-order description itself, alongside a
known-seam note that CLV rows recorded before 2026-09-12 are contaminated."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by |
|---|---|
| `ALTER TABLE picks ADD close_captured_at` | Task 1, Step 1 |
| Proxy backfill from `max(fetched_at)` per slate | Task 1, Step 1 |
| `IS NULL` guard makes backfill idempotent | Task 1, Step 1 |
| Demo-seed rows stay NULL by construction | Task 1, Step 3 (asserts `160`) |
| Exactly 500 stamped / 164 excluded / 336 kept | Task 1, Steps 3-5 |
| Skip API call when whole slate has started | Task 3, Step 1 (early exit); proven Step 5 |
| `openPicks` restricted by `start_time > now()` | Task 3, Step 1 |
| `close_captured_at = now()` on write | Task 3, Step 1 |
| Return type → `{ updated, skipped, gamesStarted }` | Task 3, Step 1 (`CaptureResult`) |
| Rain-delay = "started" is intentional | Task 3, Step 1 (comment) |
| Filter in `clv.ts` | Task 2, Step 1 |
| Filter in `scorecard.ts` (3 aggregates) | Task 2, Step 2 |
| No other `close_line` consumer exists | Task 2 preamble |
| First-pitch reporting in CLI | Task 3, Steps 2-3 |
| CLI-only; no dashboard change | Global Constraints; Task 3 |
| Expected effect: n 500→336, CLV −0.0085→−0.0023 | Task 2, Steps 4-5 |
| Falling `n` stated in the commit, not buried | Task 2, Step 6 commit message |
| Zero API calls proven | Task 3, Step 5 |
| `npm run typecheck` exits 0 | Tasks 2 and 3, Step 2a/4 |
| `build:db` + compiled-output check | Task 2, Step 3 |
| Record contamination of pre-2026-09-12 CLV | Task 4, Step 2 |

No spec requirement is without a task. Task 4 is additive beyond the spec's explicit sections: the timing rule existed in `HANDOFF.md` only as a comment on an example command, which is why it was never enforced. Verified during self-review that the `+0.265%` figure appears in no tracked doc, so Task 4 documents a new invariant rather than retracting a published number.

**Placeholder scan:** no TBDs, no "handle edge cases", no "similar to Task N". Every code step carries complete code; every command step carries an exact command and an expected result, including the specific measured numbers (500, 164, 336, 160, 157, 126, 42, 18, 150, −0.0023) that make the checks falsifiable.

**Type consistency:**
- `CaptureResult` — declared Task 3 Step 1, consumed Task 3 Step 3. All six fields (`updated`, `skipped`, `gamesStarted`, `nextFirstPitch`, `lastFirstPitch`, `fetched`) are read in the CLI action; `nextFirstPitch`/`lastFirstPitch` are `Date | null` and are null-guarded together before `fmtUtc`.
- `fmtUtc(d: Date): string` — defined Task 3 Step 2, called twice in Task 3 Step 3.
- `close_captured_at` — created Task 1, read Task 2 (both queries), written Task 3. Column name identical in all four places.
- `clvByProp` and `getScorecard` keep their existing signatures and return types, so `clv/index.ts` and the dashboard need no changes.
- `timing.next_start` / `timing.last_start` are typed `Date | null`; `pg` returns `timestamptz` as a JS `Date`, and `min`/`max` over an empty filtered set yield `null` — which is why the early-exit branch returns `nextFirstPitch: null` explicitly.

**Ordering dependencies:** Task 1 must precede Tasks 2 and 3 — both reference a column it creates. Task 2 before Task 3 is preferred (it makes the honest numbers visible immediately and its Step 4/5 expectations assume no new captures have been written), but they are otherwise independent. Task 4 is documentation and can run last.
