import { query } from '../pool.js';
import type { ExplorerPlayer, PropGame, MatchupContext } from '../types.js';

// Queries for the prop explorer (/props). Master-detail: pick a game, pick a
// player, see that player's game-by-game history for one prop against the
// market line.

// Players with a projection on a game, so the list only offers players the
// model can actually say something about.
export async function getGamePlayers(gameId: number): Promise<ExplorerPlayer[]> {
  const res = await query<{
    player_id: number; full_name: string; props: string[]; team_id: number | null;
  }>(
    // The team cannot come from this game's box score -- an upcoming game has
    // none, and upcoming games are what this list is for. The lateral picks the
    // player's team from this game's row when it exists and falls back to their
    // most recent appearance otherwise, matching getMatchupContext.
    `SELECT p.player_id, pl.full_name,
            array_agg(DISTINCT p.prop_type ORDER BY p.prop_type) AS props,
            t.team_id
     FROM projections p
     JOIN players pl ON pl.id = p.player_id
     LEFT JOIN LATERAL (
       SELECT x.team_id FROM (
         SELECT b.team_id, g2.game_date, (b.game_id = p.game_id) AS this_game
         FROM player_game_batting b JOIN games g2 ON g2.id = b.game_id
         WHERE b.player_id = p.player_id AND b.team_id IS NOT NULL
         UNION ALL
         SELECT pp.team_id, g2.game_date, (pp.game_id = p.game_id) AS this_game
         FROM player_game_pitching pp JOIN games g2 ON g2.id = pp.game_id
         WHERE pp.player_id = p.player_id AND pp.team_id IS NOT NULL
       ) x
       ORDER BY x.this_game DESC, x.game_date DESC
       LIMIT 1
     ) t ON TRUE
     WHERE p.game_id = $1
       AND p.model_version = (SELECT max(model_version) FROM projections)
     GROUP BY 1, 2, t.team_id
     ORDER BY pl.full_name`,
    [gameId],
  );
  return res.rows.map((r) => ({
    playerId: r.player_id, playerName: r.full_name, props: r.props, teamId: r.team_id,
  }));
}

// Which box-score column a prop is graded against.
//
// This duplicates the mapping that actualFor() owns in the pipeline, which is a
// known wart -- see the pitcher-props spec, which calls for moving props.ts
// into this package so both sides import one table. Until that happens the two
// MUST agree; a disagreement here would plot a different number than the
// backtest grades against.
// `platoon` is the equivalent expression over player_game_platoon, and its
// ABSENCE is meaningful: that table stores only pa/singles/doubles/triples/hr/so
// per pitcher hand, so runs, RBIs and walks have no per-hand split at all.
// Props without it must ignore the handedness filter rather than silently
// plotting a whole-game total under a "vs LHP" label.
const PROP_COLUMN: Record<string, { table: 'bat' | 'pit'; expr: string; platoon?: string }> = {
  total_bases: {
    table: 'bat', expr: 'b.tb',
    platoon: 'pp.singles + 2*pp.doubles + 3*pp.triples + 4*pp.hr',
  },
  hits: {
    table: 'bat', expr: 'b.h',
    platoon: 'pp.singles + pp.doubles + pp.triples + pp.hr',
  },
  home_runs: { table: 'bat', expr: 'b.hr', platoon: 'pp.hr' },
  strikeouts: { table: 'pit', expr: 'b.so' },

  // Straight box-score columns; exact, no modelling involved.
  runs: { table: 'bat', expr: 'b.r' },
  rbis: { table: 'bat', expr: 'b.rbi' },
  batter_walks: { table: 'bat', expr: 'b.bb' },
  // The composite books quote as H+R+RBI. A player who singles and scores on
  // the next hit gets credit twice by design -- that is the prop, not an error.
  hits_runs_rbis: { table: 'bat', expr: 'b.h + b.r + b.rbi' },

  // Pitcher props. These are CHART-only: plotting what a pitcher already did is
  // just a box-score column, and carries no claim. The pitcher-props spec's
  // objections -- earned runs cluster, outs are censored by the manager -- are
  // about PROJECTING them, which nothing here does.
  pitcher_outs: { table: 'pit', expr: 'b.outs' },
  earned_runs: { table: 'pit', expr: 'b.er' },
  hits_allowed: { table: 'pit', expr: 'b.h' },
  pitcher_walks: { table: 'pit', expr: 'b.bb' },
};

// Which props read a pitcher's line rather than a batter's. Drives both the
// hover card and the header totals: showing a pitcher's plate appearances and
// batting average would be noise at best.
export const PITCHER_PROPS: readonly string[] =
  Object.entries(PROP_COLUMN).filter(([, m]) => m.table === 'pit').map(([k]) => k);

export interface PropHistoryFilters {
  /** 'all' | 'home' | 'away' */
  venue?: string;
  /** 'all' | 'L' | 'R' -- handedness of the pitcher faced. Uses the PA-level
   *  platoon table, so it is exact rather than a starter approximation. */
  hand?: string;
  limit?: number;
}

// One player's game-by-game outcomes for one prop, newest first.
export async function getPropHistory(
  playerId: number, prop: string, filters: PropHistoryFilters = {},
): Promise<PropGame[]> {
  const map = PROP_COLUMN[prop];
  if (!map) return [];
  const limit = Math.min(Math.max(filters.limit ?? 15, 1), 50);

  const params: unknown[] = [playerId];
  const where: string[] = ['NOT g.is_synthetic'];

  if (filters.venue === 'home') where.push('b.team_id = g.home_team_id');
  else if (filters.venue === 'away') where.push('b.team_id = g.away_team_id');

  // Handedness filtering only applies to BATTER props: player_game_platoon is
  // keyed by the hand of the pitcher a BATTER faced, so it says nothing about a
  // pitcher's own strikeout total. Silently applying it there would filter
  // games by an unrelated fact.
  // Also requires a platoon expression: without one there is no per-hand value
  // to plot, and filtering games while showing the whole-game total would
  // attribute plate appearances against the other hand to this split.
  const handed = (filters.hand === 'L' || filters.hand === 'R')
    && map.table === 'bat' && map.platoon != null;

  let handJoin = '';
  let valueExpr = map.expr;
  if (handed) {
    params.push(filters.hand);
    handJoin = `JOIN player_game_platoon pp
                  ON pp.game_id = g.id AND pp.player_id = $1
                 AND pp.pitch_hand = $${params.length} AND pp.pa > 0`;
    // Take the value FROM the split, not from the whole game. Filtering games
    // by "he faced a lefty at some point" while still plotting his full game
    // total would attribute plate appearances against right-handers to the
    // left-handed split -- a silently wrong number, and most games contain
    // both (35 of this sample player's 96 games had PAs against each hand).
    valueExpr = map.platoon!;
  }

  const src = map.table === 'bat'
    ? `player_game_batting b`
    : `player_game_pitching b`;

  // `limit` is deliberately NOT a bind parameter: DISTINCT ON must lead its own
  // ORDER BY with game_id, so the newest-first sort and the cut both happen in
  // JS below. Passing it here would send a parameter the statement never
  // references, which Postgres rejects outright.
  const res = await query<{
    game_id: number; game_date: string; value: number;
    opponent: string | null; opponent_id: number | null; home: boolean;
    team_runs: string | null; opp_runs: string | null;
    pa: number | null; ab: number | null; h: number | null;
    doubles: number | null; triples: number | null; hr: number | null;
    so: number | null; bb: number | null; hbp: number | null; sf: number | null;
    p_outs: number | null; p_bf: number | null; p_h: number | null;
    p_er: number | null; p_bb: number | null; p_so: number | null;
  }>(
    `SELECT DISTINCT ON (g.id) g.id AS game_id,
            to_char(g.game_date, 'YYYY-MM-DD') AS game_date,
            ${valueExpr} AS value,
            CASE WHEN b.team_id = g.home_team_id THEN ta.name ELSE th.name END AS opponent,
            CASE WHEN b.team_id = g.home_team_id THEN g.away_team_id ELSE g.home_team_id END AS opponent_id,
            (b.team_id = g.home_team_id) AS home,
            -- No score column exists, so both sides' runs are summed from the
            -- box score, the same way the game page and slate cards do it.
            (SELECT sum(x.r) FROM player_game_batting x
              WHERE x.game_id = g.id AND x.team_id = b.team_id) AS team_runs,
            (SELECT sum(x.r) FROM player_game_batting x
              WHERE x.game_id = g.id AND x.team_id IS DISTINCT FROM b.team_id) AS opp_runs,
            -- The player's batting line for the game, for the hover card.
            -- LEFT JOIN because a pitcher prop selects from player_game_pitching
            -- and the player may have no batting row at all.
            bl.pa, bl.ab, bl.h, bl.doubles, bl.triples, bl.hr, bl.so, bl.bb, bl.hbp, bl.sf,
            pl.outs AS p_outs, pl.bf AS p_bf, pl.h AS p_h, pl.er AS p_er,
            pl.bb AS p_bb, pl.so AS p_so
     FROM ${src}
     JOIN games g ON g.id = b.game_id
     ${handJoin}
     LEFT JOIN player_game_batting bl ON bl.game_id = g.id AND bl.player_id = $1
     LEFT JOIN player_game_pitching pl ON pl.game_id = g.id AND pl.player_id = $1
     LEFT JOIN teams th ON th.id = g.home_team_id
     LEFT JOIN teams ta ON ta.id = g.away_team_id
     WHERE b.player_id = $1 AND ${where.join(' AND ')}
     ORDER BY g.id, g.game_date DESC`,
    params,
  );

  // DISTINCT ON needs game_id leading its ORDER BY, so the date sort and the
  // limit are applied here rather than in SQL.
  return res.rows
    .map((r) => ({
      gameId: r.game_id, date: r.game_date, value: Number(r.value),
      opponent: r.opponent, opponentId: r.opponent_id, home: r.home,
      teamRuns: r.team_runs == null ? null : Number(r.team_runs),
      oppRuns: r.opp_runs == null ? null : Number(r.opp_runs),
      pa: r.pa, ab: r.ab, h: r.h,
      doubles: r.doubles, triples: r.triples, hr: r.hr, so: r.so, bb: r.bb,
      hbp: r.hbp, sf: r.sf,
      pOuts: r.p_outs, pBf: r.p_bf, pH: r.p_h, pEr: r.p_er, pBb: r.p_bb, pSo: r.p_so,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, limit);
}

// Batting totals over the same filtered window the chart plots.
//
// Deliberately computed from the PropGame rows already fetched rather than by a
// second query: a separate SELECT would drift out of sync with the venue and
// handedness filters the moment either changed, and the whole point of the
// strip is that it describes the games on screen.
//
// Hit rate is NOT here. It depends on the line, and the line is adjustable in
// the chart -- computing it server-side would freeze it at the market's number
// and disagree with the bars as soon as the reader moved the rule.
export interface PlayerTotals {
  games: number;
  pa: number; ab: number; h: number; bb: number; hbp: number; sf: number;
  hr: number; so: number; doubles: number; triples: number;
  avg: number | null;
  obp: number | null;
  babip: number | null;
  /** Pitching aggregates, for the pitcher props. ERA and WHIP are the two
   *  figures a pitcher header is read for, and both are exact from what is
   *  stored -- unlike the batter side, which needed migration 011 first. */
  pOuts: number; pBf: number; pH: number; pEr: number; pBb: number; pSo: number;
  era: number | null;
  whip: number | null;
}

export function totalsFrom(games: PropGame[]): PlayerTotals {
  const sum = (f: (g: PropGame) => number | null) =>
    games.reduce((a, g) => a + (f(g) ?? 0), 0);

  const pa = sum((g) => g.pa), ab = sum((g) => g.ab), h = sum((g) => g.h);
  const bb = sum((g) => g.bb), hbp = sum((g) => g.hbp), sf = sum((g) => g.sf);
  const hr = sum((g) => g.hr), so = sum((g) => g.so);

  // Exact formulas, which is why migration 011 added hbp/sf. Dropping those
  // terms gets close and is quietly wrong, which is worse than being absent.
  const obpDen = ab + bb + hbp + sf;
  const babipDen = ab - so - hr + sf;

  const pOuts = sum((g) => g.pOuts), pBf = sum((g) => g.pBf), pH = sum((g) => g.pH);
  const pEr = sum((g) => g.pEr), pBb = sum((g) => g.pBb), pSo = sum((g) => g.pSo);
  const ip = pOuts / 3;

  return {
    games: games.length,
    pa, ab, h, bb, hbp, sf, hr, so,
    doubles: sum((g) => g.doubles), triples: sum((g) => g.triples),
    avg: ab > 0 ? h / ab : null,
    obp: obpDen > 0 ? (h + bb + hbp) / obpDen : null,
    babip: babipDen > 0 ? (h - hr) / babipDen : null,
    pOuts, pBf, pH, pEr, pBb, pSo,
    era: ip > 0 ? (pEr * 9) / ip : null,
    whip: ip > 0 ? (pH + pBb) / ip : null,
  };
}

// The market line and the model's projection for a player/prop on a slate, so
// the chart has something to draw a reference rule against.
export async function getPropReference(
  playerId: number, gameId: number, prop: string,
): Promise<{ line: number | null; projMean: number | null }> {
  const line = (
    await query<{ line: string }>(
      `SELECT ml.line FROM market_lines ml JOIN games g ON g.id = ml.game_id
       WHERE ml.player_id = $1 AND ml.game_id = $2 AND ml.prop_type = $3
         AND ml.fetched_at < g.start_time
       ORDER BY ml.is_sharp DESC, ml.fetched_at DESC LIMIT 1`,
      [playerId, gameId, prop],
    )
  ).rows[0];
  const proj = (
    await query<{ proj_mean: string }>(
      `SELECT proj_mean FROM projections
       WHERE player_id = $1 AND game_id = $2 AND prop_type = $3
         AND model_version = (SELECT max(model_version) FROM projections)`,
      [playerId, gameId, prop],
    )
  ).rows[0];
  return {
    line: line ? Number(line.line) : null,
    projMean: proj ? Number(proj.proj_mean) : null,
  };
}

// Who the batter faces, and how they have hit that hand.
//
// Pitch-type splits are the obvious next column here and are NOT available:
// per-pitch data is in the live feed we already download, but nothing stores
// it. Deliberately absent rather than approximated.
export async function getMatchupContext(
  gameId: number, playerId: number,
): Promise<MatchupContext | null> {
  const g = (
    await query<{
      home_team_id: number | null; away_team_id: number | null;
      venue_name: string | null;
      condition: string | null; temp_f: string | null; wind: string | null;
    }>(
      `SELECT g.home_team_id, g.away_team_id, g.venue_name, c.condition, c.temp_f, c.wind
       FROM games g LEFT JOIN game_conditions c ON c.game_id = g.id
       WHERE g.id = $1`,
      [gameId],
    )
  ).rows[0];
  if (!g) return null;

  // The player's own team decides which probable pitcher is the OPPOSING one.
  //
  // It cannot come from this game's box score: an UPCOMING game has none, and
  // an upcoming game is the whole point of this page. So prefer this game's row
  // when it exists and fall back to the player's most recent team otherwise.
  const side = (
    await query<{ team_id: number | null }>(
      `SELECT team_id FROM (
         SELECT b.team_id, g.game_date, (b.game_id = $1) AS this_game
         FROM player_game_batting b JOIN games g ON g.id = b.game_id
         WHERE b.player_id = $2 AND b.team_id IS NOT NULL
         UNION ALL
         SELECT p.team_id, g.game_date, (p.game_id = $1) AS this_game
         FROM player_game_pitching p JOIN games g ON g.id = p.game_id
         WHERE p.player_id = $2 AND p.team_id IS NOT NULL
       ) t
       ORDER BY t.this_game DESC, t.game_date DESC
       LIMIT 1`,
      [gameId, playerId],
    )
  ).rows[0];
  const playerTeam = side?.team_id ?? null;
  const oppSide = playerTeam == null ? null : playerTeam === g.home_team_id ? 'away' : 'home';

  const pitcher = oppSide == null ? undefined : (
    await query<{ pitcher_id: number; full_name: string; throws: string | null }>(
      `SELECT pp.pitcher_id, pl.full_name, pl.throws
       FROM probable_pitchers pp JOIN players pl ON pl.id = pp.pitcher_id
       WHERE pp.game_id = $1 AND pp.side = $2`,
      [gameId, oppSide],
    )
  ).rows[0];

  // Career-to-date split against that hand, from the PA-level platoon table.
  const hand = pitcher?.throws === 'L' || pitcher?.throws === 'R' ? pitcher.throws : null;
  const split = hand == null ? undefined : (
    await query<{ pa: string; hits: string; hr: string; so: string; tb: string }>(
      `SELECT sum(pa) AS pa,
              sum(singles + doubles + triples + hr) AS hits,
              sum(hr) AS hr,
              sum(so) AS so,
              sum(singles + 2*doubles + 3*triples + 4*hr) AS tb
       FROM player_game_platoon
       WHERE player_id = $1 AND pitch_hand = $2`,
      [playerId, hand],
    )
  ).rows[0];

  const n = split ? Number(split.pa) : 0;
  return {
    venue: g.venue_name,
    condition: g.condition,
    tempF: g.temp_f == null ? null : Number(g.temp_f),
    wind: g.wind,
    pitcher: pitcher
      ? { playerId: pitcher.pitcher_id, playerName: pitcher.full_name, throws: pitcher.throws }
      : null,
    vsHand: hand == null || n === 0 ? null : {
      hand,
      pa: n,
      hitsPerPa: Number(split!.hits) / n,
      hrPerPa: Number(split!.hr) / n,
      soPerPa: Number(split!.so) / n,
      tbPerPa: Number(split!.tb) / n,
    },
  };
}
