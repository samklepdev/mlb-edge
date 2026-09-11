import 'dotenv/config';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  databaseUrl: env('DATABASE_URL', 'postgres://mlb:mlb@localhost:5432/mlb_edge'),
  mlbApiBase: env('MLB_API_BASE', 'https://statsapi.mlb.com'),
  oddsApiKey: process.env.ODDS_API_KEY ?? null,
} as const;
