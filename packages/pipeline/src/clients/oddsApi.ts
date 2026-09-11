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

async function getJson<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ apiKey: requireKey(), ...params }).toString();
  const url = `${config.oddsApiBase}${path}?${qs}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Odds API ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export function getEvents(): Promise<OddsEvent[]> {
  return getJson<OddsEvent[]>('/sports/baseball_mlb/events', {});
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
