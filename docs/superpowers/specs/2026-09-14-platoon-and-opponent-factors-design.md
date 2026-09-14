# Platoon splits and opponent-allowed factors

**Date:** 2026-09-14
**Status:** draft, not yet approved

## Goal

Give the batter projection two real matchup inputs it currently lacks:

1. **Platoon** — the batter's own rates split by the handedness of the pitcher
   actually faced.
2. **Opponent allowed** — what the opposing team's pitching gives up, replacing
   `pitcherTbFactor`, which `factors.ts:29` itself labels a proxy.

This targets the seam `CLAUDE.md` already documents: "Park factors are a stub
table; the pitcher factor is a hits-allowed proxy."

## The finding that determines the whole shape

**`ingest games` already downloads exact plate-appearance-level platoon data
for every game, and throws it away.**

`ingestBoxscore` (`packages/pipeline/src/ingest/games.ts:31`) calls
`getLiveFeed(gamePk)` and reads exactly one thing from it —
`feed.gameData.weather`. The same payload carries
`liveData.plays.allPlays[]`, and every play has:

```json
{ "matchup": { "batter":    { "fullName": "…" },
               "batSide":   { "code": "L" },
               "pitcher":   { "fullName": "…" },
               "pitchHand": { "code": "R" } },
  "result":  { "event": "Single", "type": "atBat" } }
```

Verified live against game 823009: 83 plays, `batSide` and `pitchHand` present
on the first one, ~910KB for the payload. The feed is also **not** archived —
`raw_api_responses` holds only `boxscore` (2,759) and `schedule` (230) — so
this data has been fetched and discarded thousands of times.

**The consequence: going forward, exact platoon data costs zero additional API
requests.** It is a parsing change to a payload already in memory.

### Why that matters more than it sounds

The obvious cheap alternative is to attribute a batter's whole game line to the
*opposing starter's* hand. That approach is both diluted and biased, and should
not be built:

- A starter faces roughly 55-65% of a game's plate appearances. The rest are
  bullpen, so a "vs LHP" game line is really ~60% LHP and ~40% mixed.
- The contamination is not random. Managers deploy same-handed relievers
  deliberately, so the bullpen share correlates with batter hand — exactly the
  variable being measured.
- `probable_pitchers` covers only **2,396 of 4,782 games**, so for half of
  history the starter would itself have to be proxied by `max(bf)` per
  (game, team) — a proxy on top of a proxy. (Observed minimum of that max is 4
  batters faced, i.e. at least one game-team where it identifies an opener, not
  a starter.)

PA-level data removes every one of those compromises. Given the project's
standing objection to dressing up proxies, taking the diluted version when the
exact version is already being downloaded would be hard to defend.

A bonus that falls out for free: `batSide` is the side **actually used** in that
plate appearance, so switch-hitters are handled correctly rather than collapsing
to a single `players.bats = 'S'`.

## Current state, verified

- **`players.bats` and `players.throws` exist and are 100% empty** — 0 of 4,155
  rows populated. The columns are in `001_core.sql`; nothing ever wrote them.
- **Handedness is not recoverable from the archived boxscores.** The stored
  `person` object carries only `id`, `link`, `fullName`, `boxscoreName`.
- So even the season-level fallback needs a new fetch: `/api/v1/people`
  (batchable via `personIds=`) is the cheap source, ~4,155 players.
- The batter projection folds every matchup effect into a single scalar `adj`
  (`projectors.ts:50-66`), clamped to `[0.7, 1.4]`. That is the seam a platoon
  factor plugs into — but see "Model change" for why a multiplier is the wrong
  shape.

## Data model

New table, one row per (game, batter, pitcher hand):

```sql
CREATE TABLE player_game_platoon (
  game_id    INTEGER NOT NULL REFERENCES games(id),
  player_id  INTEGER NOT NULL REFERENCES players(id),
  pitch_hand TEXT    NOT NULL CHECK (pitch_hand IN ('L','R')),
  bat_side   TEXT    NOT NULL CHECK (bat_side  IN ('L','R')),
  pa         INTEGER NOT NULL DEFAULT 0,
  singles    INTEGER NOT NULL DEFAULT 0,
  doubles    INTEGER NOT NULL DEFAULT 0,
  triples    INTEGER NOT NULL DEFAULT 0,
  hr         INTEGER NOT NULL DEFAULT 0,
  so         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, player_id, pitch_hand, bat_side)
);
```

`bat_side` is in the key, not derived from `players.bats`, because a switch
hitter legitimately produces two rows per game.

**Reconciliation gate (hard requirement).** For every (game, player),
`sum(player_game_platoon.pa)` must equal `player_game_batting.pa`, and the same
for each of singles/doubles/triples/hr/so. Play-by-play event parsing is the
risky part of this whole change — `allPlays` includes non-atBat rows, and event
strings must map to the same outcomes the boxscore counted. A per-game
reconciliation against a source already known to be correct is a stronger check
than any unit test here, and it must pass before the model reads the table.

## Model change

Two-stage shrinkage, not a multiplier. A platoon factor folded into `adj` would
be a league-average platoon effect applied to every batter identically, which is
not what a platoon split is for — the point is that batters differ in it.

```
rate_vs_hand = shrink(own vs-hand counts → own overall rate,   K_PLATOON)
rate_overall = shrink(own overall counts → league rate,        K_PA)      [today]
```

The inner shrink is unchanged, so a batter with no vs-LHP sample degrades
exactly to today's v0.3 estimate. `K_PLATOON` is a new constant in `model.ts`.

Expected PAs must also be split: roughly `min(expPa, starterPa)` against the
probable starter's hand and the remainder against a league-average bullpen hand
mix. Both projections are then mixed, not averaged — the PMF is the weighted
convolution, so `pOverFromPmf` keeps working unchanged downstream.

**Opponent allowed** replaces `pitcherTbFactor` with rates computed from
existing box scores (no new ingest): the opposing team's allowed per-PA outcome
rates over `RECENT_DAYS`, shrunk to league. `teamKFactor` already does exactly
this shape for the pitcher K prop and is the template.

## Phasing

Each phase is independently shippable and independently verifiable.

1. **`ingest people`** — populate `players.bats`/`throws`. No model change. Its
   own PR.
2. **Platoon capture** — migration, parse `allPlays` in `ingestBoxscore`,
   reconciliation gate. Still no model change: the table is written and checked
   before anything reads it. Requires a history re-ingest (see below).
3. **Opponent-allowed factor** — replaces `pitcherTbFactor`. `MODEL_VERSION`
   bump, re-backfill, re-backtest.
4. **Platoon in the projector** — two-stage shrink. `MODEL_VERSION` bump,
   re-backfill, re-backtest.

Phases 3 and 4 bump the version separately **on purpose**. Shipping them
together makes it impossible to attribute a calibration change to either one.

## The history re-ingest

Phase 2 needs `feed/live` re-fetched for completed games — roughly 2,400 games
at ~900KB, so ~2GB, sequential, against a public no-key API. `getJson`
(`clients/mlbStatsApi.ts:6`) has **no throttle**; pacing today is incidental,
from sequential `await`s. Add a small delay before running a loop of this size.

This is the only expensive step in the plan, it is one-time, and every game
ingested after it is free.

## What would falsify this

State it before measuring, so it cannot be rationalised after:

> **Hypothesis.** Adding real platoon splits and opponent-allowed rates lowers
> per-prop ECE and Brier against v0.3, on a date range that was not used to
> choose `K_PLATOON`.

Per `CLAUDE.md`: prove it by re-backfilling and re-backtesting on a **different**
range than any used for tuning. If ECE does not improve, that is a result —
record it and stop. Do **not** sweep `K_PLATOON` to rescue it; that is the
mistake already on record from the v0.3 pricing work, where the fixes were
right and the predicted improvement simply did not appear.

Note also that a platoon split can improve *discrimination* while leaving ECE
flat — ECE is a calibration measure, and a better-resolved model is not
automatically a better-calibrated one. Report both, plus the no-information
baseline, or the comparison is not interpretable.

## Non-goals

- **No Statcast.** `xwOBA`, `Barrel%`, `HH%` and the rest of the advanced block
  need a Baseball Savant ingest and are out of scope.
- **No park-factor rewrite.** Still a stub; a separate job.
- **No new props.**
- **No pooled-across-props headline figure.** Per-prop only, as today.
