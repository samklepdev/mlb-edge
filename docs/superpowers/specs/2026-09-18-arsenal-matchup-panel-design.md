# Arsenal matchup panel: versus pitch types

**Date:** 2026-09-18
**Status:** draft, not yet approved

## Goal

Build the panel the prop explorer currently stubs at `apps/web/src/app/page.tsx:408`
("Versus pitch types — Not built"), as a **cross** between the probable
starter's arsenal and the selected batter's swing decisions against those same
pitch types.

Plus one in-scope fix to a pre-existing lookahead leak in the panel directly
above it (see "The bug this exposes").

## Why now, and why this one

This came out of a survey of what [propsmadness.com](https://propsmadness.com)
offers that we don't. The honest answer was: most of it is hit-rate and streak
presentation, which CLAUDE.md names as "the most seductive and least predictive
figure in prop betting." A cross-player hit-rate board would be the fastest
thing to ship and the one our own discipline rules are most wary of.

The pitch-type panel is the exception, on three counts:

1. **The data is already here.** `game_pitches` (migration `014_game_pitches.sql`)
   holds **710,422 pitches across 2,416 games**, the full 2026 season
   (2026-03-15 → 2026-09-17, 184 dates). `is_swing`, `is_whiff`, `in_zone`,
   `pitch_type` and `start_speed` are already computed at ingest. No migration,
   no new API surface, no backfill.
2. **It is descriptive fact, not a confidence claim.** "This pitcher throws a
   sinker 48% of the time" and "this batter whiffs on 24% of his swings at
   curveballs" are things that happened. Neither is a projection and nothing in
   the model reads them.
3. **The stub is a promise.** The explorer explicitly tells the reader this is
   deliberately absent rather than approximated. Leaving it there while adding
   softer features would be the wrong order.

## What the data supports, measured

Everything below is measured, not assumed. The sample-size ceiling drove most
of the design, so it comes first.

### Pitch types are clean, with a short tail

| type | n | share |
|---|---|---|
| FF | 217,372 | 30.6% |
| SI | 117,896 | 16.6% |
| SL | 94,171 | 13.3% |
| CH | 79,394 | 11.2% |
| ST | 58,357 | 8.2% |
| FC | 57,413 | 8.1% |
| CU | 45,480 | 6.4% |
| FS | 22,745 | 3.2% |
| KC | 10,956 | 1.5% |
| SV, EP, FA, FO, KN, CS, UN, SC | < 1% each | ~2.4% total |
| (null) | 689 | 0.1% |

`trajectory` is likewise already classified (`ground_ball` 51,067, `fly_ball`
33,124, `line_drive` 29,173, `popup` 8,842).

### Arsenals are small enough to table

Pitchers with 1,000+ pitches (n=261, i.e. starters) throw an average of
**4.6 pitch types at ≥5% usage**, range 2–7. So the table is 4–6 rows. That is
small enough to afford an explicit uncertainty column per row.

### Whiff rates survive. Batted-ball quality does not.

The **busiest batter in the database** — the most-pitched-to hitter we have —
season to date:

| type | pitches | swings | balls in play | whiff% | approx ±95% |
|---|---|---|---|---|---|
| FF | 875 | 428 | 127 | 20.8% | ±3.8pp |
| SI | 417 | 196 | 84 | 11.7% | ±4.5pp |
| SL | 356 | 157 | 46 | 36.3% | ±7.6pp |
| CH | 310 | 126 | 44 | 19.0% | ±6.9pp |
| FC | 299 | 144 | 48 | 20.8% | ±6.6pp |
| ST | 261 | 114 | 37 | 27.2% | ±8.2pp |
| CU | 171 | 83 | 32 | 24.1% | ±9.2pp |
| FS | 77 | 40 | 11 | 37.5% | ±15pp |
| KC | 48 | 26 | 6 | 26.9% | ±17pp |

Three conclusions, all of which constrain the design:

- **Whiff and chase rates are usable down to roughly 150 swings** and become
  noise below ~50. Both are per-*pitch* or per-*swing* denominators, which is
  what keeps them alive.
- **Contact quality per pitch type is not viable.** 46 balls in play is the
  *second-best* pitch for the *most-pitched-to hitter in the league*. Exit
  velocity, barrel rate and batted-ball mix are therefore **excluded** from the
  per-pitch-type table. They are honest only as whole-window figures, which is
  not what this panel is for.
- **The right-rail Window filter cannot apply.** Restricting the same batter to
  his last 15 games leaves **49 swings on fastballs and 12 on sliders**:

  | type | pitches | swings | whiffs |
  |---|---|---|---|
  | FF | 78 | 49 | 9 |
  | CH | 32 | 15 | 3 |
  | SI | 32 | 18 | 5 |
  | FC | 23 | 9 | 3 |
  | SL | 22 | 12 | 7 |

  Twelve swings supports no statement at all.

### Handedness is not split

Splitting the batter's half by the starter's throwing hand costs about half the
sample — that batter's sliders go 157 swings → 82 vs LHP / 75 vs RHP, and his
changeups vs LHP fall to 25 swings. Given that the **vs-LHP/RHP table directly
above this panel already carries the handedness signal at PA level**, the
batter's half pools both hands and the caption says so. A slider from a lefty
genuinely is a different pitch; that correctness is traded for roughly √2
tighter intervals, deliberately, and stated in the UI rather than hidden.

## Design

### Data layer

One new query in `packages/db/src/queries/explorer.ts`:

```ts
export interface ArsenalRow {
  pitchType: string;          // raw code, e.g. 'SI'
  // pitcher half
  usage: number;              // 0..1, share of his pitches
  velo: number | null;        // avg start_speed, null if unrecorded
  pWhiffPct: number | null;   // his whiffs / his swings induced, all batters
  pSwings: number;            // denominator for the above
  // batter half — null/0 when this batter has never seen the pitch
  bSwings: number;
  bWhiffPct: number | null;
  bWhiffLo: number | null;    // Wilson bounds, 95%
  bWhiffHi: number | null;
  bOutZone: number;           // pitches seen outside the zone
  bChasePct: number | null;
  bChaseLo: number | null;
  bChaseHi: number | null;
}

export async function getArsenalMatchup(
  batterId: number | null,   // null => pitcher-only mode, see below
  pitcherId: number,
  asOf: string,              // the selected game's date
): Promise<ArsenalRow[]>
```

Two aggregates over `game_pitches`, full-outer-joined on `pitch_type`, then
filtered to the pitcher's ≥5% types:

- **Pitcher half** — `WHERE pitcher_id = $2 AND g.game_date < $3`, grouped by
  `pitch_type`: `count(*)`, `avg(start_speed)`, and
  `count(*) FILTER (WHERE is_whiff) / count(*) FILTER (WHERE is_swing)`.
  `usage` is that type's count over the total of **non-null** `pitch_type`
  rows, so usage sums to ~100% rather than to 99.9%. The ≥5% cut is computed
  over this same `asOf`-capped season, not over the pitcher's career — an
  arsenal that changed mid-season should be read as it stands on the day.
  `pSwings` is returned though the table does not print it: it is the
  denominator behind `pWhiffPct`, and a starter with too few induced swings
  (a callup, or a first start) needs his own column suppressed to `—` on the
  same grounds as the batter's.
- **Batter half** — same shape on `batter_id`, both hands pooled:
  - whiff% = `count(*) FILTER (WHERE is_whiff)` / `count(*) FILTER (WHERE is_swing)`
  - chase% = `count(*) FILTER (WHERE is_swing AND NOT in_zone)` /
    `count(*) FILTER (WHERE NOT in_zone)`

`game_pitches` has no date column, so both halves join `games`. The existing
`(batter_id, pitch_type)` and `(pitcher_id, pitch_type)` indexes carry the
lookup; the date predicate then lands on a few thousand rows.

**`asOf` is the selected game's date, not today.** The explorer browses past
slates, and a season-to-date figure that silently includes games after the one
being viewed is a lookahead leak in display. This matches the guard CLAUDE.md
already documents for projection history (`game_date < target`).

Rows are returned sorted by `usage` descending.

### Wilson intervals live in `prob.ts`

`packages/db/src/prob.ts` is the single documented home for shared probability
math ("Don't duplicate it"). Add:

```ts
export function wilson(x: number, n: number, z = 1.96): { lo: number; hi: number };
```

**This means `npm run build:db` before the web app sees any of it** — rule 1 in
CLAUDE.md.

**Rendering decision, refined from the approved mock:** the mock showed
`24% ±9`. A Wilson interval is *asymmetric* about the point estimate, and at
the small n this panel exists to be honest about (n=44, p̂=0.23) the asymmetry
is several percentage points — large enough that "±" would be a claim the
arithmetic does not support. The table therefore renders explicit bounds:
`24% (16–35)`. Same width on screen, and it does not assert a symmetry that
isn't there.

### Presentation

New **server** component `apps/web/src/app/_components/ArsenalTable.tsx` — no
client JS, matching the rest of the page, which is entirely server-rendered
with state in the URL. It replaces the `.ex-todo` notice block at
`page.tsx:408–417`.

```
Versus pitch types                          Framber Valdez (LHP)

                    ── pitcher ──       ── batter, season to date ──
Pitch        Use%   Velo   Whiff%     Swings   Whiff%        Chase%
Sinker        48%   93.1     14%         196   12% (9–16)    24% (21–28)
Curve         27%   79.4     31%          83   24% (16–35)   31% (25–38)
Changeup      18%   88.6     29%         126   19% (13–26)   28% (23–34)
Cutter         7%   90.2     19%          44   23% (13–37)   26% (17–38)
```

- Sorted by the pitcher's usage, so row one is the pitch actually coming.
- Types under 5% usage are **omitted**, with a one-line count ("2 pitch types
  under 5% usage not shown"). Not folded into an "Other" row: averaging a
  knuckle-curve with an eephus produces a number about nothing.
- Pitch codes render as words via a small map, in the same spirit as
  `PropLabel`. Unmapped codes fall back to the raw code rather than being
  dropped.
- The table sits in a `.tscroll` region with `tabIndex={0}` and an
  `aria-label`, matching the vs-hand table above it.

**No colour at all.** CLAUDE.md permits `--good`/`--bad` only on settled facts
*and* only where colour is redundant against another visual channel. A table
has no such channel — colour would be the sole carrier, failing for a
colour-blind or greyscale reader — and this panel is matchup context feeding a
hypothesis, not a graded outcome. Chrome only.

**The caption must state four things:**

1. The right-rail Window / Venue / Hand filters do not apply here, and why —
   twelve swings on a slider in a 15-game window supports nothing. This reuses
   the pattern already established at `page.tsx:320–327` for the hand filter on
   props with no platoon split.
2. The batter's half pools both pitcher hands; the table above splits by hand
   at PA level.
3. Nothing in the model reads these numbers. They are context, not input.
4. A wide interval means the row is noise, not a small effect.

## Edge cases

| Case | Behaviour |
|---|---|
| **Selected player is a pitcher** (`strikeouts`, `pitcher_outs`, …) | The cross inverts: `getMatchupContext` returns the *opposing* starter, which is meaningless when the selected player pitches. Show the selected pitcher's **own** arsenal — pitcher half only, heading "Arsenal" rather than "Versus pitch types". Same query with `batterId = null`. |
| No probable starter listed | `page.tsx:366` already says so. Panel renders nothing. |
| Pitcher has no pitch history (callup, first start, or start predates ingest) | Explicit "no pitch data for this starter", not an empty table. |
| Batter has no pitch history | Render the pitcher half; batter cells `—` with a note. "Here is what he throws" still stands on its own. |
| Pitcher throws a pitch the batter has never swung at | **Keep the row**, batter cells `—`, swings 0. That he throws a splitter 12% of the time and this batter has never offered at one is information, not an absence. |
| Selected game at/before 2026-03-15 | Both halves empty; say so rather than rendering a blank table. |
| `pitch_type` null (689 rows, 0.1%) | Excluded from both halves *and* from the usage denominator. |
| Doubleheader | `game_date < asOf` drops both games of that date, losing game 1 when game 2 is selected. Conservative, and consistent with the projection lookahead guard. Accepted, not special-cased. |

## The bug this exposes

`getMatchupContext`'s platoon query (`packages/db/src/queries/explorer.ts:575–581`)
has **no date filter**. It sums `player_game_platoon` career-to-date, including
games *after* the selected date:

```sql
SELECT sum(pa) AS pa, ...
FROM player_game_platoon
WHERE player_id = $1 AND pitch_hand = $2
```

Browse a past slate and the vs-LHP/RHP table shows the batter's full-season
line, future included.

The new panel is date-capped. Placing them adjacent puts two panels on one
screen that disagree about what "to date" means, with the **older one being the
wrong one**. Fixed in scope: join `games` and add `AND g.game_date < $3`,
threading the selected game's date through — the same value `getArsenalMatchup`
already takes.

This changes existing rendered figures on past slates. See verification.

## Out of scope

Named explicitly, because each was considered and rejected rather than missed:

- **Exit velocity / barrel / batted-ball mix per pitch type** — measured above
  as not viable. Would be honest only as a whole-window figure.
- **Handedness split on the batter's half** — halves n; the PA-level table
  above already carries handedness.
- **Feeding any of this into the projector.** These are display-only. Whether
  pitch-level features improve the model is a separate question and a separate
  spec; it would need its own backfill and a backtest on a different date range
  than any window used to develop it.
- **xwOBA / xBA / SIERA and the rest of the PropsMadness glossary.** Not
  derivable from what `game_pitches` stores without a run-expectancy model.
- **Hit rate, avg diff, diff %, cross-player board, similar players, season
  chips, fantasy-score props.** The rest of the PropsMadness survey. Deferred,
  and the hit-rate family deliberately so.

## Verification

- `npm run build:db` — **mandatory**. Touches `prob.ts` and `queries/`; skip it
  and nothing changes at runtime. Confirm with
  `grep wilson packages/db/dist/prob.js`.
- `npm run typecheck`.
- `npm run parity` — requires `next build` first, then `PARITY_BASE` pointed at
  a server whose build matches `.next/BUILD_ID`; parity refuses a stale one, and
  a stale read looks like a pass. **Two expected diff classes:**
  1. New figures from the panel — expected, baseline regenerated deliberately.
  2. **Changed** figures on past slates from the platoon lookahead fix. This is
     a true positive. It must be recorded as intended with the reason, not
     waved through — the whole point of parity is that presentation changes
     prove they moved no data, and this one moves data on purpose.
- `npm run contrast` — no new colours, so expected clean. Cheap; run it.
- Spot-check: pick a known sinkerballer and confirm the sinker sorts first with
  a plausible usage share and velocity.

No migration. `game_pitches` already has every column this needs.
