# `lines reprice` skips started games — design

**Date:** 2026-09-13
**Status:** approved, ready for implementation plan
**Follows:** `2026-09-12-guard-live-quotes-design.md` (merged in `5f9e77c`)

## Problem

`lines pull` and `lines capture` both refuse to touch a game whose first pitch
has passed. `lines reprice` does not check game start at all. Two consequences:

**It writes picks nobody can act on.** On 2026-09-12, 259 of the 424 picks
`reprice` wrote were on games already underway — later 390 of 424 as more games
started. A pick on a game in progress is not a bet you can place.

**It deletes captured closing lines.** `priceAndWritePicks` does
`DELETE FROM picks WHERE game_id = ANY($1)` and re-inserts, wiping `close_line`,
`close_odds`, `close_fair_prob`, `clv_pct`, `close_captured_at`, and `result`.
This is not hypothetical: a `reprice` run on 2026-09-12 destroyed that slate's
343 captured closes (303 of them clean), taking the CLV sample from 336 rows to
33. Because 14 of the 15 games had started, those closes could not be
recaptured. The loss was permanent.

The previous branch added a `--force` gate that refuses when the slate has
captured closes. That stops the *silent* case but leaves `reprice`'s contract
wrong: it still prices games that cannot be bet.

## Design

### 1. Filter started games out of `loadStoredLines`

```sql
AND g.start_time > now()
```

A NULL `start_time` is excluded, consistent with every other guard in this file
(`startedGameIds`, the `fetched_at` read guard): an unverifiable start time is
never trusted.

This is the entire behavioural change. Everything below follows from it.

### 2. Preservation of started games' picks is automatic

`priceAndWritePicks` derives its delete scope from the rows it is given:

```ts
const gameIds = [...new Set(rows.map((r) => r.gameId))];
await c.query('DELETE FROM picks WHERE game_id = ANY($1)', [gameIds]);
```

So a started game excluded from `loadStoredLines` never contributes a `gameId`,
the `DELETE` never names it, and its picks — including any captured closes —
survive untouched. No UPDATE-preserving rewrite and no special-casing are
needed.

This is the same property that already makes `lines pull` safe: started games
contribute no rows, so `pull`'s delete skips them.

**This property is load-bearing and must be proven by test, not assumed.** It is
the difference between "reprice no longer destroys closes" and "reprice happens
not to destroy closes today."

### 3. The `--force` guard must narrow to upcoming games

`repriceLines` currently counts **every** pick on the slate with a `close_line`
and refuses if any exist. Once started games are excluded, that test is wrong.

Measured now:

| slate | picks | closes (whole slate) | closes on **upcoming** games |
|---|---|---|---|
| 2026-09-11 | 157 | **157** | **0** |
| 2026-09-12 | 424 | 0 | 0 |

`reprice --date 2026-09-11` would touch nothing at all — every game has started
— yet the current guard counts 157 and refuses. A refusal that fires when the
command is provably harmless trains the operator to reach for `--force`, which
is precisely the wrong reflex given what `--force` does.

The guard must therefore count only picks on games with `start_time > now()` —
the only picks `reprice` can still delete.

### 4. Reporting

`RepriceResult` gains `startedGamesSkipped`: the number of distinct games on the
slate that **have stored `market_lines` rows and have already started** — that
is, exactly what the new filter excluded, not simply how many games are
underway.

The two coincide today (on both 2026-09-11 and 2026-09-12 all 15 games have
stored lines and all 15 have started), but they diverge on any slate where a
game was never pulled. Counting what was actually excluded is the honest figure:
a game with no stored lines was not skipped by this filter, it had nothing to
skip.

The CLI must explain a zero-line run rather than printing a bare
`re-priced 0 stored line(s)`. A success-shaped message on an empty result is the
same defect class already fixed twice — in `capture`'s early exit and in
`pull`'s diagnostics.

```
re-priced 0 stored line(s); wrote 0 pick(s) — 0 API credits
Hint: all 15 game(s) with stored lines on 2026-09-12 have started; nothing is
still bettable, and existing picks were left untouched.
```

When some games are still upcoming, the skip count is reported alongside the
normal output rather than as a hint.

### 5. Documentation

`CLAUDE.md` and `AGENTS.md` (byte-identical twins) currently state that
`reprice` "does not check game start at all, only whether a closing line was
captured." This change makes that false. The seam bullet must be rewritten to
describe the new behaviour and to record that started games' picks are preserved
because the delete scope is derived from the returned rows.

## Expected effect

- `reprice` prices only what is still bettable.
- Picks on started games are never rewritten, so captured closes on them cannot
  be destroyed by `reprice` at all — the `--force` path included.
- On a fully-started slate, `reprice` reads 0 lines, writes 0 picks, and deletes
  nothing.
- The `--force` guard still protects the one case that remains: an upcoming game
  whose closes were captured before first pitch, then repriced.

## Verification

This repo has **no test runner, no test files, and no lint script**. Verification
is `npm run typecheck` plus database checks with exact expected values.

**The order of steps 1 and 2 is itself a safety property and must not be
reversed.**

1. **`npm run lines -- reprice --date 2026-09-12` first.** Expect `0` lines read,
   `0` picks written, and all **424** picks still present afterwards. Safe to run
   even if the change is broken: those picks carry no closing lines, so the worst
   case is pick churn with nothing lost.
2. **Only if step 1 read 0 lines**, run `npm run lines -- reprice --date
   2026-09-11`. Expect `0` lines read, `0` picks written, and **157 picks with
   157 closes** still present. If the filter works on 2026-09-12 it provably
   works here, since the mechanism is identical. **This must not run first:**
   2026-09-11 holds the last intact CLV data in the project, and a broken filter
   would delete it exactly as the previous incident did.
3. **Prove the narrowed guard by SQL, not by triggering it.** Count picks with a
   `close_line` on upcoming games for both slates; both must be `0`, confirming
   no refusal should fire. Triggering a *true* refusal would require capturing
   closes on an upcoming game first — ~120 credits against a 204 balance, with no
   ingested slate to do it on.
4. `npm run typecheck` exits 0.
5. `reprice` makes no API call; quota must remain **204**.

## Out of scope

- No change to `MODEL_VERSION`, `K_BF`, `K_PA`, the edge threshold, or the
  de-vig method.
- No schema change, no migration, no mutation of existing rows beyond what
  `reprice` itself does.
- No change to `lines pull` or `lines capture`; both already refuse started
  games.
- Does not remove the `--force` flag. It still guards the upcoming-game case.
- Does not address the absent *lower* bound on capture lead time (none of the 33
  surviving CLV rows were captured within an hour of first pitch). Separate
  question, already recorded as a known seam.

## Accepted risks

- **Step 2 of verification touches the project's last intact CLV data.** It is
  gated behind step 1 passing, but the residual risk is not zero. The
  alternative — never testing the preservation property against real captured
  closes — leaves the load-bearing claim of this design unverified, which is
  worse.
- **No live slate exists to test the normal path.** 2026-09-13 has no ingested
  games and 2026-09-12 is fully started, so the "some games upcoming, some
  started" case — the one that actually matters in daily use — cannot be
  exercised. It is correct by construction and by the SQL checks, but its first
  real run will be on a future slate.
