import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Load .env file from the current working directory or any of its parent directories.
 *
 * This allows for a more flexible configuration setup, especially in monorepos or nested project structures.
 *
 * The function will search up to 8 levels of parent directories for a .env file.
 *
 * If no .env file is found, it will fallback to the default behavior of dotenv, which is to load from the current working directory.
 */
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

/**
 * Retrieves the value of the specified environment variable.
 *
 * If the variable is not set, the provided fallback value is used.
 * Throws an error if the environment variable is required and no fallback is provided.
 *
 * @param {string} name - The name of the environment variable to retrieve.
 * @param {string} [fallback] - An optional fallback value to use if the
 * environment variable is not set.
 * @return {string} The value of the environment variable or the fallback value.
 * @throws {Error} If the environment variable is not set and no fallback value is provided.
 */
function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/**
 * Configuration object for the application.
 *
 * @typedef {Object} Config
 * @property {string} databaseUrl - The connection URL for the application's PostgreSQL database. Defaults to 'postgres://mlb:mlb@localhost:5432/mlb_edge'.
 * @property {string} mlbApiBase - The base URL for accessing the MLB API. Defaults to 'https://statsapi.mlb.com'.
 * @property {string} oddsApiBase - The base URL for accessing the Odds API. Defaults to 'https://api.the-odds-api.com/v4'.
 * @property {string|null} oddsApiKey - The API key for authenticating with the Odds API. Defaults to `null` if not set in the environment.
 */
export const config = {
  databaseUrl: env('DATABASE_URL', 'postgres://mlb:mlb@localhost:5432/mlb_edge'),
  mlbApiBase: env('MLB_API_BASE', 'https://statsapi.mlb.com'),
  oddsApiBase: env('ODDS_API_BASE', 'https://api.the-odds-api.com/v4'),
  oddsApiKey: process.env.ODDS_API_KEY ?? null,
} as const;
