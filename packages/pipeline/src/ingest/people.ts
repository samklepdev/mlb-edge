import { getPeople } from '../clients/mlbStatsApi.js';
import { query } from '@mlb-edge/db';

// Populate players.bats / players.throws.
//
// Those two columns have existed since 001_core.sql and were never written --
// 0 of 4,155 rows populated before this command. Nothing in the model reads
// them yet; this fills them so a platoon split has something to stand on.
//
// The source has to be /api/v1/people. Handedness is NOT in the boxscore
// payloads already archived in raw_api_responses: their `person` object is
// only { id, link, fullName, boxscoreName }. So this is a genuinely new fetch,
// but a cheap one -- personIds batches, and 4k players is a handful of
// requests rather than one per player.
const PEOPLE_BATCH = 100;

// `getJson` has no throttle and this is the only loop in the codebase that
// issues more than a few requests back to back, so pace it rather than lean on
// sequential awaits being slow enough.
const PAUSE_MS = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// MLB reports switch hitters as 'S' and switch pitchers as 'S'. Both are stored
// verbatim: collapsing 'S' to a side here would throw away the fact that the
// player has no fixed side, and the PA-level feed already reports the side
// ACTUALLY used in each plate appearance, which is the honest source for a
// switch hitter's matchup.
const HAND = /^[LRS]$/;

export interface PeopleIngestResult {
  requested: number;
  updated: number;
  missing: number;   // ids the API returned no record for
  unparsed: number;  // records whose hand codes were absent or unrecognised
}

// Backfills every player that is missing handedness. Pass `all` to refresh
// players that already have it (handedness effectively never changes, so the
// default is to skip them and keep the run cheap).
export async function ingestPeople(opts: { all?: boolean } = {}): Promise<PeopleIngestResult> {
  const ids = (
    await query<{ id: number }>(
      // Demo-seed players live on sentinel ids (see CLAUDE.md) and have no
      // real MLB record; asking the API about them would return nothing and
      // inflate `missing` on every run.
      `SELECT id FROM players
       WHERE id < 900000
         ${opts.all ? '' : 'AND (bats IS NULL OR throws IS NULL)'}
       ORDER BY id`,
    )
  ).rows.map((r) => r.id);

  const result: PeopleIngestResult = { requested: ids.length, updated: 0, missing: 0, unparsed: 0 };
  if (ids.length === 0) return result;

  for (let i = 0; i < ids.length; i += PEOPLE_BATCH) {
    const batch = ids.slice(i, i + PEOPLE_BATCH);
    const res = await getPeople(batch);
    const people = res.people ?? [];
    const seen = new Set<number>();

    for (const p of people) {
      seen.add(p.id);
      const bats = p.batSide?.code?.toUpperCase();
      const throws = p.pitchHand?.code?.toUpperCase();
      if (!bats || !throws || !HAND.test(bats) || !HAND.test(throws)) {
        result.unparsed++;
        continue;
      }
      // Only ever fills or corrects handedness; never touches full_name or
      // position, which the schedule and boxscore ingests own.
      await query('UPDATE players SET bats = $2, throws = $3 WHERE id = $1', [p.id, bats, throws]);
      result.updated++;
    }
    result.missing += batch.filter((id) => !seen.has(id)).length;

    if (i + PEOPLE_BATCH < ids.length) await sleep(PAUSE_MS);
  }

  return result;
}
