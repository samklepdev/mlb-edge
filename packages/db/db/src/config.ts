import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Load the nearest .env walking up from the current working directory. npm
// workspace scripts run with cwd set to the package dir (e.g. packages/pipeline),
// so a plain `dotenv/config` would miss the repo-root .env. This finds it.
function loadDotenv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      loadEnv({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  loadEnv(); // fallback to default behavior (cwd, or nothing)
}
loadDotenv();

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  databaseUrl: env('DATABASE_URL', 'postgres://mlb:mlb@localhost:5432/mlb_edge'),
  mlbApiBase: env('MLB_API_BASE', 'https://statsapi.mlb.com'),
  oddsApiBase: env('ODDS_API_BASE', 'https://api.the-odds-api.com/v4'),
  oddsApiKey: process.env.ODDS_API_KEY ?? null,
} as const;
