# Player headshot on the player page

**Date:** 2026-09-11
**Status:** approved, not yet implemented

## Goal

Show a small circular headshot beside the player's name on `/player`, so the
page identifies who it is at a glance.

This is cosmetic. It must not add a schema surface, a build step, or a failure
mode that can take down the page's actual content.

## Key enabling fact

`players.id` is the MLB person id (`packages/pipeline/migrations/001_core.sql:19`,
commented `-- MLB person id`). MLB's public image CDN is keyed by that same id,
so headshots require **no new ingest, no schema change, and no API key**.

## Approach

Plain `<img>` against MLB's CDN, rendered by the existing server component.

```
https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_112,q_auto:best/v1/people/{id}/headshot/67/current
```

The `d_people:generic:headshot:67:current.png` segment is a Cloudinary *default
image* transform: when the CDN has no headshot for that id, it serves a generic
silhouette instead of a 404. That single detail is what makes unmatched players
and the demo seed's sentinel ids degrade gracefully with no client-side code.

`w_112` requests 2x pixels for a 56px display box.

### Approaches rejected

- **`next/image`** — buys resizing and AVIF/WebP, but costs an
  `images.remotePatterns` entry, and for one fixed 56px square the payoff is
  marginal. It also routes the request through Next's optimizer, which surfaces
  an upstream 404 as an error rather than letting the CDN's own default
  transform absorb it. We would be adding configuration in order to lose the
  fallback behavior.
- **Ingesting and caching headshots locally** — the only option that works
  offline, but it means a migration, an ingest command, and a storage decision
  in service of a cosmetic feature. Rejected as YAGNI.

## Scope

Two files touched, one file added. No changes to `@mlb-edge/db`, the pipeline,
or the database — therefore **no `npm run build:db` and no `npm run db:migrate`**.

### New: `apps/web/src/app/_components/Headshot.tsx`

A server component:

```
{ playerId: number; name: string; size?: number }  ->  <img>
```

It exists to hold the one non-obvious thing in this feature — the CDN transform
string — behind a named seam, rather than inlining an opaque URL in page markup.
It lives in `_components/` to match the existing `RosterSearch.tsx` and
`ReliabilityPlot.tsx`, which is also where a future slate thumbnail would reuse
it.

`size` defaults to 56 and drives both the rendered box and the requested width
(`w_{size * 2}`), so the 2x relationship is expressed once rather than
duplicated at each call site.

### Changed: `apps/web/src/app/player/page.tsx`

Inside the `card` branch only, wrap the existing

```tsx
<h2>{card.playerName} · {card.date}</h2>
```

in a flex row containing `<Headshot>` and the `<h2>`.

The error and not-found branches are deliberately untouched: in both cases there
is no player to show, and in the not-found case the id may not be a real person
id at all.

### Changed: `apps/web/src/app/globals.css`

One `.player-id` flex rule, plus `border-radius: 50%`, `object-fit: cover`, and
a subtle ring using the existing `--hair` token. No new custom properties.

## Accessibility

`alt=""` — the image is decorative.

The player's name sits immediately beside it as real text. Giving the image the
name as alt text would make a screen reader announce the name twice in a row.
The headshot conveys nothing a non-sighted user is not already receiving from
the heading.

## Failure modes

| Condition | Result |
|---|---|
| Unknown / unmatched player id | CDN serves the generic silhouette |
| Demo seed sentinel ids (2099-01-01) | CDN serves the generic silhouette |
| Offline, or CDN unreachable | Browser's broken-image state inside a 56px box |

In every case the table, projections, and edges render normally. Nothing on the
page depends on the image resolving.

## Verification

This repo has no test harness for the web app, so verification is manual:

1. `npm run typecheck`
2. `npm run web:dev`, load a real player page, confirm the headshot renders and
   the heading alignment is right.
3. Load a demo-seed player (`?date=2099-01-01`), confirm the generic silhouette
   appears rather than a broken image.

`apps/web/AGENTS.md` warns that this Next.js version differs from training data;
consult `node_modules/next/dist/docs/` before writing the component. The chosen
approach uses no Next-specific image API, which limits the exposure.

## Out of scope

- Thumbnails in the home-page slate table. Considered and set aside to keep this
  change small; `Headshot.tsx` is shaped so that adding them later is a call
  site, not a rewrite.
- Team logos.
- Displaying `position` / `bats` / `throws`, which exist in the `players` table
  but are not shown today.
