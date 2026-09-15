# Runbook — getting data, projections, and game data

Ordered commands for filling the database and getting the dashboard to show
something. Every command runs **from the repo root**; arguments after `--` pass
through to the CLI.

`HANDOFF.md` has the full command reference and the reasoning behind each
stage. This file is the sequence.

---

## 0. Before anything

```bash
docker compose up -d      # Postgres
npm install               # postinstall builds @mlb-edge/db
npm run db:migrate        # NOT automatic — it mutates data
```

Two rules that cause most of the confusion in this repo:

- **`@mlb-edge/db` runs from compiled `dist/`.** After editing that package run
  `npm run build:db`, or the change is invisible at runtime. The pipeline runs
  from source via tsx, so its edits are live.
- **Schema changes need `npm run db:migrate`.** Pulling a fresh copy needs both
  `npm install` and `npm run db:migrate`.

`.env` at the repo root; config searches upward, so it loads from any workspace
directory. `ODDS_API_KEY` is required for the `lines` commands **only**.

---

## 1. Games and teams — `ingest schedule`

Creates the `games`, `teams`, and `probable_pitchers` rows everything else
hangs off. Nothing downstream works until a date has been through this.

```bash
npm run ingest -- schedule --date 2026-09-14
npm run ingest -- schedule --from 2026-09-01 --to 2026-09-14   # or a range
```

Both `schedule` and `games` accept `--date` **or** `--from`/`--to`, never a
mix; a lone `--from` is treated as a typo and refused.

Check it landed:

```sql
SELECT game_date, count(*), min(status), max(status)
FROM games WHERE NOT is_synthetic GROUP BY 1 ORDER BY 1 DESC LIMIT 5;
```

---

## 2. Box scores — `ingest games`

Pulls box scores for games already stored as **Final**. This is the model's
history: without it there is nothing to project *from* and nothing to grade
*against*.

```bash
npm run ingest -- games --date 2026-09-13
npm run ingest -- games --from 2026-09-01 --to 2026-09-13
```

It only touches games whose status already matches final/completed, so running
it for today before the games end is a no-op — run it again after.

> **Re-run `ingest schedule` for that date first.** `ingest games` reads the
> status stored in the database, not the status at MLB
> (`games.ts`: `/final|completed|game over/i.test(r.status)`). A date ingested
> while its games were still `Scheduled` or `In Progress` keeps that stale
> status forever, so `ingest games` finds nothing final and pulls zero box
> scores — silently, reporting `0 final game(s)`. `ingest schedule` upserts
> `status`, so running it again refreshes them to `Final` and unblocks the
> box-score pull.

Check it landed:

```sql
SELECT g.game_date,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM player_game_batting b WHERE b.game_id = g.id)) AS with_boxscore,
       count(*) AS games
FROM games g WHERE NOT g.is_synthetic GROUP BY 1 ORDER BY 1 DESC LIMIT 5;
```

---

## 3. Projections — `project`

Turns history into a distribution per player per prop, written to
`projections.dist`. **Games appear on the dashboard without this**, marked
"not projected" — but they carry no edges until it runs.

```bash
npm run project -- --date 2026-09-14
npm run project -- --date 2026-09-14 --prop hits    # one prop only
```

Props: `total_bases | hits | home_runs | strikeouts | all` (default `all`).

Check it landed:

```sql
SELECT g.game_date, count(DISTINCT p.game_id) AS projected_games, count(*) AS rows
FROM projections p JOIN games g ON g.id = p.game_id
GROUP BY 1 ORDER BY 1 DESC LIMIT 5;
```

> If the slate shows games as "not projected", this is the step that was
> skipped. The games are ingested, not missing.

---

## 4. Market lines and edges — `lines pull`

Needs `ODDS_API_KEY`. Prices the model against the de-vigged market and writes
edge `picks`.

```bash
npm run lines -- pull --date 2026-09-14 --sharp pinnacle --regions us,eu
```

Options: `--books` (default `draftkings,fanduel`), `--sharp` (default
`pinnacle`), `--regions` (default `us`; pinnacle needs `eu`), `--edge`
(default `0.03`).

**Odds only exist for upcoming games.** The free tier has no historical odds,
which is why backtesting here is model-vs-reality, not market-edge.

`lines pull` replaces a slate's picks idempotently, and skips games whose first
pitch has passed — a price quoted after first pitch is a live in-game price.

---

## 5. Closing lines — `lines capture`

```bash
npm run lines -- capture --date 2026-09-14 --sharp pinnacle --regions us,eu
```

**Must run BEFORE first pitch.** It skips started games, so running it late
silently captures less and less. This is the input to CLV, which is the only
real test of whether the model beats the market.

---

## 6. After the games — `ingest games` again, then `settle`

```bash
npm run ingest -- games --date 2026-09-14     # box scores now exist
npm run settle -- --date 2026-09-14           # grade picks vs actual outcomes
```

`settle` takes a single `--date` only — loop it for a range:

```bash
for d in 2026-09-10 2026-09-11 2026-09-12; do npm run settle -- --date "$d"; done
```

---

## 7. History and calibration — `backfill`, then `backtest`

`backfill` projects a past range **and** evaluates it against what actually
happened, filling `model_evals`. It is what the reliability plot reads.

```bash
npm run backfill -- --from 2026-08-25 --to 2026-09-07
npm run backtest      # per-prop ECE, Brier, reliability
```

Read each prop against itself. The pooled figure mixes props with different
base rates and is not a meaningful summary.

> Proving a calibration change requires re-backfilling and re-backtesting on a
> **different** date range than the one it was tuned on. Tuning until one
> window's ECE looks good is overfitting.

---

## 8. Reports and the dashboard

```bash
npm run health        # date coverage, sample vs shrinkage, eval counts
npm run clv           # closing line value on settled picks
npm run calibrate     # reliability on settled picks
npm run web:dev       # dashboard at :3000
```

On the dashboard: the slate date is changeable with the prev/next controls and
the date input, so any ingested date can be browsed — including dates with no
projections yet. Clicking a game card opens its detail page.

---

## The short version

```bash
docker compose up -d && npm install && npm run db:migrate

# history → calibration
npm run ingest -- schedule --from 2026-08-25 --to 2026-09-07
npm run ingest -- games    --from 2026-08-25 --to 2026-09-07
npm run backfill -- --from 2026-08-25 --to 2026-09-07
npm run backtest

# today → forward test
npm run ingest  -- schedule --date 2026-09-14
npm run project -- --date 2026-09-14
npm run lines   -- pull    --date 2026-09-14 --sharp pinnacle --regions us,eu
npm run lines   -- capture --date 2026-09-14 --sharp pinnacle --regions us,eu   # before first pitch

# after the games are final
npm run ingest -- games --date 2026-09-14
npm run settle -- --date 2026-09-14
```

---

## Order matters

Each stage reads the previous stage's output, and **the dates must match**:

```
ingest schedule → ingest games → project → lines pull → lines capture → settle
                       ↓
                   backfill → backtest
```

Common failure modes, all of which look like a broken command but are not:

| Symptom | Cause |
| --- | --- |
| Games show as "not projected" | `project` has not run for that date |
| Slate shows nothing at all | `ingest schedule` has not run for that date |
| `ingest games` reports `0 final game(s)` | stored status is stale — re-run `ingest schedule` for that date first |
| `project` produces nothing | no box-score history yet — run `ingest games` for earlier dates |
| No edges after `lines pull` | no `ODDS_API_KEY`, or every game has already started |
| CLV empty | `lines capture` never ran before first pitch |
| A `@mlb-edge/db` change has no effect | `npm run build:db` not run |

---

## Not on `main` yet

These ship with the handedness/platoon branch (PR #7) and will not exist until
it merges:

```bash
npm run ingest -- people      # fills players.bats / players.throws
npm run ingest -- platoon     # PA-level platoon splits from each game's live feed
```

`ingest people` is a one-off (~41 requests for the whole player table).
`ingest platoon` backfills history at roughly 900KB per game and is resumable —
games that already have rows are skipped, so re-running it continues where it
stopped. Games ingested after that branch lands get platoon splits for free,
because `ingest games` already downloads the payload they come from.
