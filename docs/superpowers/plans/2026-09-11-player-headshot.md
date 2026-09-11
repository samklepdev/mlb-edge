# Player Headshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a 56px circular headshot beside the player's name on `/player`.

**Architecture:** A server-rendered `<img>` pointing at MLB's image CDN, which is
keyed by the same person id already stored in `players.id`. A Cloudinary
*default image* transform in the URL makes the CDN serve a generic silhouette
for ids it has no photo for, so there is no client-side fallback logic and no
broken-image state for unmatched players or demo-seed sentinel ids.

**Tech Stack:** Next.js 16.3.4 (App Router), React 19, plain CSS in `globals.css`.

**Spec:** `docs/superpowers/specs/2026-09-11-player-headshot-design.md`

## Global Constraints

- **No `next/image`.** The chosen approach deliberately avoids it; do not add
  `images.remotePatterns` to `next.config.ts`.
- **No changes to `@mlb-edge/db`, `packages/pipeline`, or the database.** This
  task therefore requires neither `npm run build:db` nor `npm run db:migrate`.
- **`_components/` uses named exports**, matching `ReliabilityPlot.tsx` and
  `RosterSearch.tsx`. Do not use a default export.
- **Do not add `'use client'`.** This is a server component. `apps/web/CLAUDE.md`
  forbids importing `@mlb-edge/db` from client files, and the player page is a
  server component that does exactly that.
- **`alt=""`** on the image, deliberately. It is decorative; the player's name
  sits beside it as text. Do not "fix" this to include the name.
- **Exact CDN URL shape** (any deviation loses the silhouette fallback):
  `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_{width},q_auto:best/v1/people/{id}/headshot/67/current`

## A note on testing

This repo has **no test runner and no test files** — there is no `test` script
in any `package.json`, and `find` turns up no `*.test.*` or `*.spec.*`. There is
also no `lint` script, and `eslint-config-next` is not installed despite
`eslint.config.mjs` referencing it (so the `@next/next/no-img-element` rule that
would normally complain about a raw `<img>` does not run here).

Standing up a test framework to unit-test a 15-line presentational component is
scope the user did not ask for, and a JSDOM assertion that an `<img>` has the
right `src` would restate the implementation rather than test behavior. So the
gates below are **`tsc --noEmit` plus specific, checkable browser observations**
rather than fabricated unit tests. Each verification step states the exact
command and the exact expected result.

---

### Task 1: Headshot component, styles, and page wiring

This is one task, not three. The component, the CSS, and the call site produce
nothing observable on their own — a reviewer could not sensibly approve two of
them and reject the third.

**Files:**
- Create: `apps/web/src/app/_components/Headshot.tsx`
- Modify: `apps/web/src/app/globals.css` (append at end)
- Modify: `apps/web/src/app/player/page.tsx` (line 2 area, and lines 46-47)

**Interfaces:**
- Consumes: `card.playerId` (`number`) and `card.playerName` (`string`) from
  `PlayerCard`, returned by `getPlayerCard` in `@mlb-edge/db`. Already present
  on the page — no query change.
- Produces:
  - `headshotUrl(playerId: number, width: number): string` — exported so a
    future slate thumbnail can build a URL without rendering this component.
  - `Headshot(props: { playerId: number; size?: number }): JSX.Element` —
    named export, `size` defaults to `56`.

> **Deviation from the spec, intentional:** the spec's interface sketch listed a
> `name: string` prop. Because `alt=""` is required, `name` would be unused.
> An unused required prop is dead weight at every call site, so it is dropped.

- [ ] **Step 1: Create the component**

Create `apps/web/src/app/_components/Headshot.tsx`:

```tsx
// MLB's image CDN is keyed by the same person id we store in `players.id`
// (see migrations/001_core.sql: `id INTEGER PRIMARY KEY -- MLB person id`),
// so headshots need no ingest, no schema, and no API key.
//
// The `d_people:generic:headshot:67:current.png` segment is a Cloudinary
// *default image* transform: when the CDN has no photo for an id it serves a
// generic silhouette instead of 404ing. That one detail is what lets unmatched
// players and the demo seed's sentinel ids degrade gracefully with no
// client-side code. Don't drop it.
const CDN = 'https://img.mlbstatic.com/mlb-photos/image/upload';

export function headshotUrl(playerId: number, width: number): string {
  return `${CDN}/d_people:generic:headshot:67:current.png/w_${width},q_auto:best/v1/people/${playerId}/headshot/67/current`;
}

export function Headshot({ playerId, size = 56 }: { playerId: number; size?: number }) {
  return (
    <img
      className="headshot"
      src={headshotUrl(playerId, size * 2)} // 2x source for the displayed box
      width={size}
      height={size}
      // Decorative: the player's name sits beside this as real text, so alt
      // text here would make a screen reader announce the name twice.
      alt=""
    />
  );
}
```

- [ ] **Step 2: Append the styles**

Append to the end of `apps/web/src/app/globals.css`:

```css
/* ---- player identity ---- */
.player-id { display: flex; align-items: center; gap: 0.85rem; margin: 0 0 1rem; }
.player-id h2 { margin: 0; }
.headshot {
  flex: none;
  border-radius: 50%;
  object-fit: cover;
  background: var(--paper);
  box-shadow: 0 0 0 1px var(--hair);
}
```

`.player-id h2 { margin: 0 }` is load-bearing: `.clv h2` already sets
`margin: 0 0 1rem`, which would otherwise push the heading down relative to the
image inside the flex row. The row carries that bottom margin instead.

- [ ] **Step 3: Wire it into the page**

In `apps/web/src/app/player/page.tsx`, add the import after the existing
`@mlb-edge/db` import on line 2:

```tsx
import { Headshot } from '../_components/Headshot';
```

Then replace this line (currently line 47):

```tsx
          <h2>{card.playerName} · {card.date}</h2>
```

with:

```tsx
          <div className="player-id">
            <Headshot playerId={card.playerId} />
            <h2>{card.playerName} · {card.date}</h2>
          </div>
```

Leave the `error` and `!card` branches alone — in both there is no player to
show, and in the not-found case the `id` may not be a real person id at all.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`

Expected: exits 0. (It builds `@mlb-edge/db` first, then typechecks pipeline and
web — that db build is incidental here, since this task changes no db source.)

- [ ] **Step 5: Verify a real player renders**

Run: `npm run web:dev`

Open the home page, click through to any player from the slate table. Confirm
all three:
1. A circular headshot appears to the **left** of the "Name · date" heading.
2. The image and heading are **vertically centered** relative to each other.
3. The gap between the heading and the table below it looks unchanged from
   before the edit (this is what Step 2's `margin` note guards).

If the slate is empty, get an id and date from the database directly:

```bash
docker compose exec db psql -U mlb -d mlb_edge -c \
  "SELECT p.player_id, g.game_date FROM projections p JOIN games g ON g.id = p.game_id LIMIT 5;"
```

then visit `http://localhost:3000/player?id=<id>&date=<date>`.

- [ ] **Step 6: Verify the silhouette fallback**

The demo seed lives on sentinel date `2099-01-01` with ids MLB's CDN will not
have. Seed it if it is not already present:

```bash
npm run seed:demo
```

Get a seeded player id:

```bash
docker compose exec db psql -U mlb -d mlb_edge -c \
  "SELECT DISTINCT p.player_id FROM projections p JOIN games g ON g.id = p.game_id WHERE g.game_date = '2099-01-01' LIMIT 3;"
```

Visit `http://localhost:3000/player?id=<id>&date=2099-01-01`.

Expected: a **generic grey silhouette** in the circle — NOT the browser's broken
image icon, and NOT an empty box. If you see a broken image, the URL transform
is wrong; re-check it character-for-character against the Global Constraints.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/_components/Headshot.tsx \
        apps/web/src/app/globals.css \
        apps/web/src/app/player/page.tsx
git commit -m "Add player headshot to the player page

Uses MLB's image CDN, keyed by players.id (already the MLB person id).
The CDN's default-image transform serves a generic silhouette for
unknown ids, so unmatched players and demo-seed sentinel ids degrade
without a broken image."
```

Note: `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` are untracked in this
working tree and are regenerated by `next dev`. Do not include them in this
commit — stage only the three paths listed above.

---

## Self-Review

**Spec coverage** — every section maps to a step:

| Spec section | Covered by |
|---|---|
| CDN approach + exact URL | Global Constraints, Step 1 |
| `Headshot.tsx` in `_components/` | Step 1 |
| `size` defaults to 56, drives `w_{size*2}` | Step 1 |
| Wrap `<h2>` in a flex row, `card` branch only | Step 3 |
| Untouched error / not-found branches | Step 3 |
| `.player-id` flex + 50% radius + `--hair` ring | Step 2 |
| `alt=""` accessibility decision | Global Constraints, Step 1 |
| Unknown id → silhouette | Step 6 |
| Demo seed sentinel ids → silhouette | Step 6 |
| No `build:db` / no `db:migrate` | Global Constraints |
| Verification: typecheck, real player, demo seed | Steps 4, 5, 6 |
| Rejected: `next/image`, local caching | Global Constraints |

Offline/CDN-down is the one spec row with no step. It is unobservable on a
working machine and requires no code, so it is documentation, not a task.

**Placeholder scan** — no TBDs, no "add error handling", no "similar to Task N".
Every code step carries complete code; every command step carries an exact
command and expected result.

**Type consistency** — `headshotUrl(playerId, width)` is defined once in Step 1
and called once, in the same file, with `size * 2`. `Headshot` is exported named
in Step 1 and imported named in Step 3. `.headshot` and `.player-id` are defined
in Step 2 and used in Steps 1 and 3 respectively. `card.playerId` matches the
`PlayerCard` type returned by `getPlayerCard`.

One inconsistency found and resolved: the spec's `{ playerId, name, size }`
became `{ playerId, size }`, since `alt=""` leaves `name` unused. Flagged inline
at the Interfaces block above.
