import { query } from '@mlb-edge/db';
import { LEAGUE_PRIOR, PITCH_PRIOR } from './model.js';
import type { LeagueBatting, BatterHistory, PitcherHistory } from './projectors.js';

const n = (v: unknown): number => Number(v ?? 0);

export interface GameRow {
  id: number;
  home_team_id: number | null;
  away_team_id: number | null;
  venue_name: string | null;
  temp_f: number | null;
}

export async function getGamesOn(date: string): Promise<GameRow[]> {
  const res = await query<GameRow>(
    `SELECT g.id, g.home_team_id, g.away_team_id, g.venue_name, c.temp_f
     FROM games g
     LEFT JOIN game_conditions c ON c.game_id = g.id
     WHERE g.game_date = $1`,
    [date],
  );
  return res.rows.map((r) => ({ ...r, temp_f: r.temp_f == null ? null : n(r.temp_f) }));
}

export async function getLeagueBatting(before: string): Promise<LeagueBatting> {
  const r = (
    await query<{ pa: number; singles: number; doubles: number; triples: number; hr: number; so: number }>(
      `SELECT sum(pa)::float8 pa,
              sum(h - doubles - triples - hr)::float8 singles,
              sum(doubles)::float8 doubles,
              sum(triples)::float8 triples,
              sum(hr)::float8 hr,
              sum(so)::float8 so
       FROM player_game_batting b JOIN games g ON g.id = b.game_id
       WHERE g.game_date < $1`,
      [before],
    )
  ).rows[0];
  const pa = n(r?.pa);
  if (pa <= 0) {
    return { p1: LEAGUE_PRIOR.p1, p2: LEAGUE_PRIOR.p2, p3: LEAGUE_PRIOR.p3, p4: LEAGUE_PRIOR.p4, soPerPa: LEAGUE_PRIOR.soPerPa };
  }
  return {
    p1: n(r.singles) / pa,
    p2: n(r.doubles) / pa,
    p3: n(r.triples) / pa,
    p4: n(r.hr) / pa,
    soPerPa: n(r.so) / pa,
  };
}

export async function getLeaguePitching(before: string): Promise<{ hPerBf: number; soPerBf: number }> {
  const r = (
    await query<{ bf: number; h: number; so: number }>(
      `SELECT sum(bf)::float8 bf, sum(h)::float8 h, sum(so)::float8 so
       FROM player_game_pitching p JOIN games g ON g.id = p.game_id
       WHERE g.game_date < $1`,
      [before],
    )
  ).rows[0];
  const bf = n(r?.bf);
  if (bf <= 0) return { hPerBf: PITCH_PRIOR.hPerBf, soPerBf: PITCH_PRIOR.soPerBf };
  return { hPerBf: n(r.h) / bf, soPerBf: n(r.so) / bf };
}

export async function getBatterHistory(before: string): Promise<Map<number, BatterHistory>> {
  const res = await query<{
    player_id: number; pa: number; singles: number; doubles: number; triples: number; hr: number; games: number;
  }>(
    `SELECT player_id,
            sum(pa)::float8 pa,
            sum(h - doubles - triples - hr)::float8 singles,
            sum(doubles)::float8 doubles,
            sum(triples)::float8 triples,
            sum(hr)::float8 hr,
            count(*)::int games
     FROM player_game_batting b JOIN games g ON g.id = b.game_id
     WHERE g.game_date < $1
     GROUP BY player_id`,
    [before],
  );
  const map = new Map<number, BatterHistory>();
  for (const r of res.rows) {
    map.set(r.player_id, {
      pa: n(r.pa), singles: n(r.singles), doubles: n(r.doubles),
      triples: n(r.triples), hr: n(r.hr), games: n(r.games),
    });
  }
  return map;
}

export async function getPitcherHistory(before: string): Promise<Map<number, PitcherHistory>> {
  // A past appearance was a START iff this pitcher was the probable starter for
  // that game -- which `probable_pitchers` records for every ingested date.
  const res = await query<{
    player_id: number; bf: number; so: number; h: number; appearances: number;
    start_bf: number | null; starts: number;
  }>(
    `SELECT p.player_id,
            sum(p.bf)::float8 bf,
            sum(p.so)::float8 so,
            sum(p.h)::float8 h,
            count(*)::int appearances,
            -- probable_pitchers is keyed (game_id, side), not (game_id,
            -- pitcher_id): nothing in the schema stops the same pitcher being
            -- recorded for both sides of one game. An EXISTS check can only
            -- ever contribute 0 or 1 per row, unlike a join on pitcher_id,
            -- which would fan out and double-count that appearance's bf into
            -- start_bf/starts if such a duplicate ever showed up.
            (sum(p.bf) FILTER (
              WHERE EXISTS (
                SELECT 1 FROM probable_pitchers pp
                WHERE pp.game_id = p.game_id AND pp.pitcher_id = p.player_id
              )
            ))::float8 start_bf,
            (count(*) FILTER (
              WHERE EXISTS (
                SELECT 1 FROM probable_pitchers pp
                WHERE pp.game_id = p.game_id AND pp.pitcher_id = p.player_id
              )
            ))::int starts
     FROM player_game_pitching p
     JOIN games g ON g.id = p.game_id
     WHERE g.game_date < $1
     GROUP BY p.player_id`,
    [before],
  );
  const map = new Map<number, PitcherHistory>();
  for (const r of res.rows) {
    map.set(r.player_id, {
      bf: n(r.bf), so: n(r.so), h: n(r.h), appearances: n(r.appearances),
      startBf: n(r.start_bf ?? 0), starts: n(r.starts),
    });
  }
  return map;
}

// Active roster proxy: each recently-active batter's most recent team.
export async function getRecentBattersByTeam(before: string, since: string): Promise<Map<number, number[]>> {
  const res = await query<{ player_id: number; team_id: number | null }>(
    `SELECT DISTINCT ON (player_id) player_id, team_id
     FROM player_game_batting b JOIN games g ON g.id = b.game_id
     WHERE g.game_date >= $2 AND g.game_date < $1
     ORDER BY player_id, g.game_date DESC`,
    [before, since],
  );
  const map = new Map<number, number[]>();
  for (const r of res.rows) {
    if (r.team_id == null) continue;
    const list = map.get(r.team_id) ?? [];
    list.push(r.player_id);
    map.set(r.team_id, list);
  }
  return map;
}

export async function getTeamKRates(before: string, since: string): Promise<Map<number, { pa: number; so: number }>> {
  const res = await query<{ team_id: number; pa: number; so: number }>(
    `SELECT team_id, sum(pa)::float8 pa, sum(so)::float8 so
     FROM player_game_batting b JOIN games g ON g.id = b.game_id
     WHERE g.game_date >= $2 AND g.game_date < $1 AND team_id IS NOT NULL
     GROUP BY team_id`,
    [before, since],
  );
  const map = new Map<number, { pa: number; so: number }>();
  for (const r of res.rows) map.set(r.team_id, { pa: n(r.pa), so: n(r.so) });
  return map;
}

export interface Probables {
  home?: number;
  away?: number;
}
export async function getProbablePitchers(gameIds: number[]): Promise<Map<number, Probables>> {
  if (gameIds.length === 0) return new Map();
  const res = await query<{ game_id: number; side: 'home' | 'away'; pitcher_id: number }>(
    'SELECT game_id, side, pitcher_id FROM probable_pitchers WHERE game_id = ANY($1)',
    [gameIds],
  );
  const map = new Map<number, Probables>();
  for (const r of res.rows) {
    const cur = map.get(r.game_id) ?? {};
    cur[r.side] = r.pitcher_id;
    map.set(r.game_id, cur);
  }
  return map;
}
