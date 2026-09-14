import { query } from '../pool.js';
import type { SlateGame, TopEdge } from '../types.js';

// The most recent date we have projections for — the "active slate".
export async function latestSlateDate(): Promise<string | null> {
  const r = (
    await query<{ d: string | null }>(
      `SELECT to_char(max(g.game_date), 'YYYY-MM-DD') AS d
       FROM projections p JOIN games g ON g.id = p.game_id`,
    )
  ).rows[0];
  return r?.d ?? null;
}

export async function getSlateGames(date: string): Promise<SlateGame[]> {
  const res = await query<{
    id: number; home: string; away: string; start_time: Date | null;
    home_id: number | null; away_id: number | null;
  }>(
    `SELECT g.id,
            th.name AS home, ta.name AS away,
            g.start_time,
            g.home_team_id AS home_id, g.away_team_id AS away_id
     FROM games g
     LEFT JOIN teams th ON th.id = g.home_team_id
     LEFT JOIN teams ta ON ta.id = g.away_team_id
     WHERE g.game_date = $1
       AND EXISTS (SELECT 1 FROM projections p WHERE p.game_id = g.id)
     ORDER BY g.start_time NULLS LAST, g.id`,
    [date],
  );
  return res.rows.map((r) => ({
    gameId: r.id, date, home: r.home, away: r.away, startTime: r.start_time,
    homeId: r.home_id, awayId: r.away_id,
  }));
}

// Highest-edge open picks on a date (the model's strongest disagreements).
export async function getTopEdges(date: string, limit = 25): Promise<TopEdge[]> {
  const res = await query<{
    player_id: number; player_name: string; game_id: number; prop_type: string;
    side: 'over' | 'under'; pick_line: string; pick_prob: string; edge_pct: string | null;
  }>(
    `SELECT pk.player_id, pl.full_name AS player_name, pk.game_id, pk.prop_type,
            pk.side, pk.pick_line, pk.pick_prob, pk.edge_pct
     FROM picks pk
     JOIN players pl ON pl.id = pk.player_id
     JOIN games g ON g.id = pk.game_id
     WHERE g.game_date = $1
     ORDER BY pk.edge_pct DESC NULLS LAST
     LIMIT $2`,
    [date, limit],
  );
  return res.rows.map((r) => ({
    playerId: r.player_id, playerName: r.player_name, gameId: r.game_id, propType: r.prop_type,
    side: r.side, line: Number(r.pick_line), modelProb: Number(r.pick_prob),
    edgePct: r.edge_pct == null ? 0 : Number(r.edge_pct),
  }));
}

// Every player projected on a date (current model version), for browsing.
export async function getSlateRoster(date: string): Promise<import('../types.js').RosterPlayer[]> {
  const res = await query<{
    player_id: number; full_name: string; props: string;
    home: string | null; away: string | null; has_pick: boolean;
  }>(
    `SELECT p.player_id,
            pl.full_name,
            string_agg(DISTINCT p.prop_type, ', ' ORDER BY p.prop_type) AS props,
            th.name AS home, ta.name AS away,
            bool_or(pk.id IS NOT NULL) AS has_pick
     FROM projections p
     JOIN players pl ON pl.id = p.player_id
     JOIN games g ON g.id = p.game_id
     LEFT JOIN teams th ON th.id = g.home_team_id
     LEFT JOIN teams ta ON ta.id = g.away_team_id
     LEFT JOIN picks pk ON pk.player_id = p.player_id AND pk.game_id = p.game_id AND pk.prop_type = p.prop_type
     WHERE g.game_date = $1 AND p.model_version = (SELECT max(model_version) FROM projections)
     GROUP BY p.player_id, pl.full_name, th.name, ta.name
     ORDER BY pl.full_name`,
    [date],
  );
  return res.rows.map((r) => ({
    playerId: r.player_id,
    playerName: r.full_name,
    matchup: r.away && r.home ? `${r.away} @ ${r.home}` : null,
    props: r.props,
    hasPick: r.has_pick,
  }));
}
