# MLB-style visual restyle of the web dashboard

**Date:** 2026-09-14
**Status:** approved, not yet implemented

## Goal

Restyle `apps/web` in the visual idiom of MLB.com / the Gameday app — navy
masthead, condensed athletic type, team logos, card-based layout — and replace
the slate's run-on matchup sentence with a row of game cards.

This is a presentation change. **If any number rendered on the page moves, that
is a bug**, not a side effect.

## The tension this design is built around

MLB.com's visual language exists to sell excitement. This project's stated
purpose is the opposite: "a large edge is a **hypothesis, not a green light**"
(`CLAUDE.md`). A straight port of the league look would dress a crude,
unvalidated model in the chrome of an authoritative one.

The resolution is a single governing rule, applied throughout:

> **Brand colors never encode data.**

Navy and red are chrome — masthead, eyebrows, rules, the pick dot. They carry no
meaning about any figure. The existing semantic colors (`--good` teal, `--bad`
maroon) stay reserved for **calibration only**, where "good" and "bad" are
genuine claims about model quality that the backtest has actually established.

Edge and CLV figures get **no color at all**. They are set in plain tabular ink
and read as measurements. This is why the restyle *removes* two existing
`good` classes (see Scope) rather than merely leaving them alone: today's green
on `edge_pct` is precisely the green light the repo warns against, and it would
look far more like an endorsement inside a broadcast-styled shell than it does
in today's restrained page.

## Key enabling facts

Three things make the Gameday look reachable without touching the pipeline,
the schema, or the ingest path:

1. **`SlateGame` already carries `homeId` and `awayId`** (`packages/db/src/types.ts:29`),
   populated from `games.home_team_id` / `away_team_id`. These are MLB team ids.
2. **MLB's logo CDN is keyed by that same team id**, exactly as the image CDN is
   keyed by person id for `Headshot.tsx`:
   `https://www.mlbstatic.com/team-logos/{teamId}.svg`.
   No ingest, no schema, no API key.
3. **`ReliabilityPlot.tsx` already reads CSS custom properties**
   (`var(--grid)`, `var(--good)`, `var(--bad)`, `var(--faint)`, `var(--muted)`)
   rather than literal hex. A palette change flows through the plot with no code
   change to it at all.

## Palette

Replaces the `:root` block in `globals.css`.

| Token | Value | Role |
|---|---|---|
| `--navy` | `#041E42` | masthead bar, section eyebrows, pick dot |
| `--navy-ink` | `#0a2d5e` | hover/active navy |
| `--red` | `#BF0D3E` | chrome accent only — masthead rule, eyebrow rule |
| `--paper` | `#f4f6f8` | page background |
| `--panel` | `#ffffff` | cards, table surfaces |
| `--stripe` | `#f7f9fa` | table zebra |
| `--ink` | `#10161d` | body text, all figures |
| `--muted` | `#5c6773` | captions, table headers |
| `--faint` | `#8a95a1` | axis labels, metadata |
| `--hair` | `#dce2e8` | borders |
| `--grid` | `#e8edf1` | plot grid, row rules |
| `--good` | `#0f766e` | **calibration only** |
| `--bad` | `#b23a48` | **calibration only** |
| `--ref` | `#aab4bf` | perfect-calibration reference line |

`--good` / `--bad` / `--ref` / `--grid` / `--faint` / `--muted` keep their
current values so the reliability plot renders identically. `--bad` is
deliberately *not* unified with `--red`: one is a claim about miscalibration,
the other is decoration, and collapsing them would let chrome read as data.

## Typography

- **Barlow Condensed** via `next/font/google`, loaded in `layout.tsx` and exposed
  as a CSS variable. Used for: wordmark, section eyebrows, table headers, team
  abbreviations, prop names, stat-card labels. Always uppercase, letter-spaced.
- **Body text and every number** keeps the existing system sans stack with
  `font-variant-numeric: tabular-nums`. Figures must stay in a face chosen for
  legibility, not for athletic flavor.

`next/font/google` fetches at build time. If the build environment is offline
this fails loudly — acceptable, and preferable to a runtime font request.

## The scoreboard strip

Replaces this, in the Slate section of `page.tsx`:

```
15 game(s): Astros @ Rangers · Yankees @ Red Sox · …
```

with a horizontally-scrolling row of cards:

```
┌──────────┐ ┌──────────┐ ┌──────────┐
│ [logo]HOU│ │ [logo]NYY│ │ [logo]LAD│   away on top (MLB convention)
│ [logo]TEX│ │ [logo]BOS│ │ [logo]SF │
│  7:05 ET │ │  6:10 ET │ │  9:10 ET │
│  4 edges │ │  2 edges │ │     —    │
└──────────┘ └──────────┘ └──────────┘
```

### Logos

Rendered as a CSS `background-image` on a fixed-size element, **not** an `<img>`.
A missing or 404ing logo then degrades to blank space rather than a broken-image
icon, and the abbreviation beside it carries the identity regardless. This is the
same graceful-degradation concern that drove the `d_people:generic` transform in
`Headshot.tsx`, solved differently because the team-logo CDN offers no equivalent
default-image transform.

### Abbreviations: a frozen map, not a migration

`teams` stores only `id` and `name` (`001_core.sql:14`). There is no
abbreviation column.

Adding one would mean a migration, an ingest change, a `db:migrate`, and a
re-ingest — to backfill 30 rows that have not changed in decades. Instead:

**New file `apps/web/src/app/_components/teams.ts`** holding
`TEAM_ABBREV: Record<number, string>`:

```
108 LAA  109 ARI  110 BAL  111 BOS  112 CHC  113 CIN  114 CLE  115 COL
116 DET  117 HOU  118 KC   119 LAD  120 WSH  121 NYM  133 ATH  134 PIT
135 SD   136 SEA  137 SF   138 STL  139 TB   140 TEX  141 TOR  142 MIN
143 PHI  144 ATL  145 CWS  146 MIA  147 NYY  158 MIL
```

Exported as `abbrev(id: number | null, name: string): string`, falling back to
the first three characters of `name`, uppercased, when the id is null or absent
from the map. An unknown id therefore still renders something truthful.

**Implementation must verify these ids against the live table** before trusting
them — `docker compose exec db psql -U mlb -d mlb_edge -c "SELECT id, name FROM teams ORDER BY id"`
— and correct any mismatch in the map. The 133/ATH entry in particular reflects
a recent franchise relocation and should be confirmed against whatever `name`
the ingest actually stored.

If anything outside the web app ever needs abbreviations, promote this to a
column then. Today it would be schema surface in service of decoration.

### Start time — the one `@mlb-edge/db` change

`games.start_time` (`TIMESTAMPTZ`) exists but is not selected.

- `packages/db/src/types.ts` — add `startTime: Date | null` to `SlateGame`.
- `packages/db/src/queries/slate.ts` — add `g.start_time` to `getSlateGames`'s
  `SELECT` and map it through.

**This requires `npm run build:db`.** `@mlb-edge/db` runs from compiled `dist/`;
without the rebuild the field is invisible at runtime and every card shows a
blank time. Verify with `grep start_time packages/db/dist/queries/slate.js`.

Formatted server-side via `Intl.DateTimeFormat` pinned to `America/New_York`
with a literal `ET` suffix. Pinning the zone is deliberate: these pages are
`force-dynamic` server renders, so an unpinned "local" time would silently mean
*the server's* local time, and a client-side conversion would introduce a
hydration mismatch for a cosmetic detail. ET is also how MLB.com labels times.

A null `start_time` renders `—`.

### Edge count per card

`d.edges` is already loaded on the page. Group it by `gameId` in the component
and show `N edges`, or `—` at zero. **No new query.** Plain text, no color, no
ranking emphasis.

## Scope by file

| File | Change |
|---|---|
| `apps/web/src/app/globals.css` | Rewritten around the palette above |
| `apps/web/src/app/layout.tsx` | `next/font/google` Barlow Condensed → CSS var |
| `apps/web/src/app/page.tsx` | Markup + classNames; game strip; **remove `good` class on `edgePct`** |
| `apps/web/src/app/player/page.tsx` | Markup + classNames; **remove conditional `good` on `edgePct`** |
| `apps/web/src/app/_components/GameCard.tsx` | **New** — one card, server component |
| `apps/web/src/app/_components/teams.ts` | **New** — `TEAM_ABBREV`, `abbrev()`, `logoUrl()` |
| `apps/web/src/app/_components/Headshot.tsx` | Add `loading="lazy"` — `size` already drives the 2x request, so 28px needs no other change |
| `apps/web/src/app/_components/RosterSearch.tsx` | Headshot in each row; navy pick dot |
| `apps/web/src/app/_components/ReliabilityPlot.tsx` | **Untouched** |
| `packages/db/src/types.ts` | `startTime` on `SlateGame` |
| `packages/db/src/queries/slate.ts` | Select `g.start_time` |

### Page-level application

**Home (`page.tsx`)** — same sections, same order, same queries:

- Masthead → full-bleed navy bar, wordmark in condensed caps, red hairline under.
- Model calibration → navy eyebrow + red rule; per-prop table zebra-striped;
  plot frame becomes a white card. Plot itself unchanged.
- Slate → the game-card strip.
- Top edges → MLB-style player rows: 28px lazy headshot, name, team chip, then
  `PROP · LINE · SIDE` in condensed caps and `model / fair / edge` in plain
  tabular ink.
- Roster → restyled search input; 28px headshot per row; `●` becomes a navy dot.
- Scorecard / CLV → readouts become white cards with condensed labels.

**Player (`player/page.tsx`)** — matching masthead; headshot to 72px with a navy
ring; nine-column table gets condensed caps headers and zebra rows.

### Copy is frozen

Every explanatory string stays **verbatim**, including:

- the masthead purpose sentence on both pages;
- all three captions in the calibration section (the per-prop warning, the
  pooled-ECE non-comparability note, the below-the-diagonal explanation);
- the "not colored — n is too low per row to call a direction" CLV caption;
- the scorecard verdict strings, including the slate-clustering caveat and the
  `excludedClose` explanation;
- the demo-seed exclusion notice;
- the database-unreachable notice and its command block.

These carry the project's actual epistemic position. Restyling them is in scope;
rewording them is not.

## Accessibility

- Team logos are decorative background images; the abbreviation beside each is
  real text. Screen readers get `HOU`, not a filename.
- Roster headshots keep `alt=""` for the reason documented in `Headshot.tsx` —
  the name sits beside them as text.
- Uppercase is applied with `text-transform`, never by uppercasing the source
  string, so assistive tech still reads the original casing.
- Navy `#041E42` on white is ~15:1; `--muted` `#5c6773` on `--stripe` `#f7f9fa`
  is ~5.5:1. Both clear AA. Any new pairing introduced during implementation
  must be checked, not assumed.
- The card strip scrolls horizontally in its own container; the page body must
  never scroll sideways.

## Failure modes

| Condition | Result |
|---|---|
| Logo CDN unreachable / unknown team id | Blank logo box; abbreviation still renders |
| `homeId` / `awayId` null | Abbreviation falls back to first 3 chars of `name` |
| `start_time` null | Card shows `—` |
| `build:db` not run | `startTime` undefined → every card shows `—`. Silent; check the grep. |
| Font fetch fails at build | Build fails loudly |
| No games on slate | Strip is not rendered; existing "No projected games" notice stands |

Nothing in the strip is load-bearing for the rest of the page.

## Verification

No test harness exists for the web app, so verification is manual and explicit:

1. `npm run build:db` — then `grep start_time packages/db/dist/queries/slate.js`
   to confirm it took.
2. `npm run typecheck`
3. `npm run web:build`
4. **Figure-parity check.** Before any change, capture the rendered text of the
   home and player pages against a real slate. After, capture again and diff.
   Every number, count, and percentage must be byte-identical. This is the
   check that proves the restyle stayed cosmetic.
5. `npm run web:dev` — visual pass on a real slate: strip renders, logos load,
   times read `ET`, headshots appear in both lists.
6. Load a demo-seed player (`?date=2099-01-01`) and confirm graceful degradation.

`apps/web/AGENTS.md` warns this Next.js version differs from training data —
consult `node_modules/next/dist/docs/` before writing the `next/font` call,
which is the only Next-specific API this design introduces.

## Out of scope

- **Persistent top nav and route splitting** (`/model`, `/clv`, `/players`).
  Considered; deferred. The page is currently one scroll and reads fine as one.
- **Team color theming per player card.** MLB.com does this; here it would mean
  a 30-team color table and a contrast problem on every accent, for decoration.
- **Dark mode.** Would roughly double the CSS and require re-tuning the plot's
  semantic colors against a dark field.
- **Live scores / game status in the cards.** `games.status` exists, but the
  card is a slate index, not a scoreboard — and this project deliberately
  excludes in-game state (see the live-quote guards in `CLAUDE.md`).
- **A team-abbreviation migration.** Explicitly rejected above.
