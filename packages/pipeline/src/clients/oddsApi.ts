import { config } from '@mlb-edge/db';

export interface OddsEvent {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
}

export interface OddsOutcome {
  name: string;         // 'Over' | 'Under'
  description?: string; // player name (player-prop markets)
  price: number;        // American odds
  point?: number;       // the line
}
export interface OddsMarket {
  key: string;          // e.g. 'batter_total_bases'
  outcomes: OddsOutcome[];
}
export interface OddsBookmaker {
  key: string;          // e.g. 'draftkings'
  title: string;
  markets: OddsMarket[];
}
export interface OddsEventOdds extends OddsEvent {
  bookmakers: OddsBookmaker[];
}

function requireKey(): string {
  if (!config.oddsApiKey) {
    throw new Error('ODDS_API_KEY is not set. Add it to .env (https://the-odds-api.com).');
  }
  return config.oddsApiKey;
}

// Last seen quota headers. The free tier is small and every call here spends
// from it, so the CLI can report what a command cost instead of the operator
// discovering it when requests start failing.
export let lastQuota: { used: number | null; remaining: number | null } = {
  used: null, remaining: null,
};

async function getJson<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ apiKey: requireKey(), ...params }).toString();
  const url = `${config.oddsApiBase}${path}?${qs}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const num = (h: string) => {
    const v = res.headers.get(h);
    return v == null || v === '' ? null : Number(v);
  };
  lastQuota = { used: num('x-requests-used'), remaining: num('x-requests-remaining') };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Odds API ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export function getEvents(): Promise<OddsEvent[]> {
  return getJson<OddsEvent[]>('/sports/baseball_mlb/events', {});
}

// Game-level markets for every upcoming MLB game in ONE request.
//
// Deliberately the league-wide /odds endpoint rather than the per-event one the
// player props use: run lines and totals come back for the whole slate at once,
// so this costs a couple of credits instead of one per game. The free tier has
// no historical odds, so this can only ever build forward.
export function getGameOdds(markets: string[], regions: string): Promise<OddsEventOdds[]> {
  return getJson<OddsEventOdds[]>('/sports/baseball_mlb/odds', {
    regions,
    markets: markets.join(','),
    oddsFormat: 'american',
  });
}

export function getEventOdds(
  eventId: string,
  markets: string[],
  regions: string,
): Promise<OddsEventOdds> {
  return getJson<OddsEventOdds>(`/sports/baseball_mlb/events/${eventId}/odds`, {
    regions,
    markets: markets.join(','),
    oddsFormat: 'american',
  });
}
