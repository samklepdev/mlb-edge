import { Command } from 'commander';
import { pool } from '@mlb-edge/db';
import { migrate } from './db/migrate.js';
import { ingestSchedule } from './ingest/schedule.js';
import { ingestFinalGames, ingestBoxscore } from './ingest/games.js';
import { seedDemo } from './seed/demo.js';
import { runProjections, ALL_PROPS, type PropKind } from './project/index.js';
import { backfill } from './project/backfill.js';
import { backtestReport } from './backtest/report.js';
import { healthReport } from './health/report.js';
import { MODEL_VERSION } from './project/model.js';
import { pullLines, captureClosing, settleResults, repriceLines, type PullOptions } from './market/lines.js';
import { clvReport } from './clv/index.js';
import { calibrationReport } from './calibration/index.js';
import { dateRange } from './dates.js';

/**
 * A string representing the help text for the `--prop` option in the CLI.
 *
 * It lists all available property kinds and includes an option for "all".
 */
const PROP_HELP = `${ALL_PROPS.join(' | ')} | all`;

function parseProps(arg: string): PropKind[] {
  if (arg === 'all') return [...ALL_PROPS];
  return (ALL_PROPS as readonly string[]).includes(arg) ? [arg as PropKind] : [];
}

/**
 * Parses provided date input and returns an array of dates based on the input format.
 *
 * @param o An object containing date-related properties.
 * @param o.date A specific date as a string. Provide this when not specifying a range.
 * @param o.from The start date of a range as a string.
 * @param o.to The end date of a range as a string.
 *
 * @return A string array of dates. Returns a single date if `date` is provided,
 * an array of dates for a range if `from` and `to` are provided, or an empty array
 * if no valid inputs are given. Throws an error if both `date` and `from`/`to` are provided simultaneously.
 */
function parseDates(o: { date?: string; from?: string; to?: string }): string[] {
  const hasRange = Boolean(o.from || o.to);
  if (o.date && hasRange) {
    throw new Error('give either --date or --from/--to, not both');
  }
  if (hasRange) return o.from && o.to ? dateRange(o.from, o.to) : [];
  return o.date ? [o.date] : [];
}

/**
 * Resolves an array of dates based on the provided input object.
 *
 * @param {Object} o - The input object containing date-related parameters.
 * @param {string} [o.date] - A specific date in string format.
 * @param {string} [o.from] - The starting date in string format.
 * @param {string} [o.to] - The ending date in string format.
 * @return {string[] | null} An array of resolved dates if successful, or null if an error occurs.
 */
function resolveDates(o: { date?: string; from?: string; to?: string }): string[] | null {
  let dates: string[];
  try {
    dates = parseDates(o);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return null;
  }
  if (dates.length === 0) {
    console.error('give either --date, or both --from and --to');
    process.exitCode = 1;
    return null;
  }
  return dates;
}

/**
 * Processes an array of date strings by applying a given asynchronous function to each date.
 *
 * @param {string[]} dates - An array of date strings to be processed.
 * @param {(date: string) => Promise<number>} fn - An asynchronous callback function that takes a date string as input and returns a Promise resolving to a number.
 * @return {Promise<{ ok: number; failed: number; total: number }>} A Promise that resolves to an object containing the counts of successfully processed dates (`ok`), failed dates (`failed`), and the total accumulated value (`total`) returned by the callback function.
 */
async function forEachDate(
  dates: string[],
  fn: (date: string) => Promise<number>,
): Promise<{ ok: number; failed: number; total: number }> {
  let ok = 0, failed = 0, total = 0;
  for (const [i, date] of dates.entries()) {
    try {
      const n = await fn(date);
      total += n;
      ok++;
      console.log(`[${i + 1}/${dates.length}] ${date}: ${n}`);
    } catch (err) {
      failed++;
      console.error(`[${i + 1}/${dates.length}] ${date}: FAILED -- ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ok, failed, total };
}

/**
 * Represents a new instance of the Command class.
 *
 * This instance is typically used to define and manage
 * command-line interface (CLI) commands along with their
 * options, arguments, and associated actions.
 */
const program = new Command();
program
  .name('mlb-edge')
  .description('MLB prop edge-finding pipeline (ingestion + CLV/calibration scaffold)');

/**
 * Represents a command-line subcommand to manage database operations.
 *
 * Configures and encapsulates functionality specific to database-related tasks,
 * enabling interaction with a program's database system through CLI.
 *
 * The `db` variable is registered as a command within the main program,
 * allowing various database operations to be performed through
 * respective subcommands or arguments it supports.
 */
const db = program.command('db');
db.command('migrate')
  .description('apply pending SQL migrations')
  .action(async () => {
    await migrate();
  });
db.command('seed:demo')
  .description('insert SYNTHETIC settled picks so the dashboard has data (dev only)')
  .action(async () => {
    const n = await seedDemo();
    console.log(`seeded ${n} synthetic picks (demo game ${999999})`);
  });

/**
 * Represents the 'ingest' command in the program.
 *
 * This variable is used to define and configure the 'ingest' command,
 * which is typically associated with processing or importing data.
 *
 * The specific behavior and options for this command are defined
 * elsewhere in the program.
 */
const ingest = program.command('ingest');
ingest
  .command('schedule')
  .description("pull a day's schedule, teams, and probable pitchers")
  .option('--date <YYYY-MM-DD>', 'single date to pull')
  .option('--from <YYYY-MM-DD>', 'start of a date range (inclusive; needs --to)')
  .option('--to <YYYY-MM-DD>', 'end of a date range (inclusive; needs --from)')
  .action(async (o: { date?: string; from?: string; to?: string }) => {
    const dates = resolveDates(o);
    if (dates === null) return;
    const r = await forEachDate(dates, ingestSchedule);
    console.log(`ingested ${r.total} game(s) across ${r.ok} date(s); ${r.failed} failed`);
    if (r.failed > 0) process.exitCode = 1;
  });
ingest
  .command('games')
  .description('pull boxscores for FINAL games already stored for a date')
  .option('--date <YYYY-MM-DD>', 'single date to pull finals for')
  .option('--from <YYYY-MM-DD>', 'start of a date range (inclusive; needs --to)')
  .option('--to <YYYY-MM-DD>', 'end of a date range (inclusive; needs --from)')
  .action(async (o: { date?: string; from?: string; to?: string }) => {
    const dates = resolveDates(o);
    if (dates === null) return;
    const r = await forEachDate(dates, ingestFinalGames);
    console.log(`ingested boxscores across ${r.ok} date(s) (${r.total} final game(s)); ${r.failed} failed`);
    if (r.failed > 0) process.exitCode = 1;
  });
ingest
  .command('game')
  .description('pull a single boxscore by gamePk')
  .requiredOption('--pk <gamePk>', 'MLB gamePk')
  .action(async (o: { pk: string }) => {
    await ingestBoxscore(Number(o.pk));
    console.log(`ingested game ${o.pk}`);
  });

/**
 * Represents the 'project' command in the program.
 *
 * This variable is used to define and configure the 'project' command,
 * which is typically associated with building projections or distributions.
 *
 * The specific behavior and options for this command are defined
 * elsewhere in the program.
 */
program
  .command('project')
  .description('build projections (distributions) for a date and write them to `projections`')
  .requiredOption('--date <YYYY-MM-DD>', 'slate date to project')
  .option('--prop <kind>', PROP_HELP, 'all')
  .action(async (o: { date: string; prop: string }) => {
    const props = parseProps(o.prop);
    if (props.length === 0) {
      console.error(`unknown --prop "${o.prop}". Use: ${PROP_HELP}`);
      process.exitCode = 1;
      return;
    }
    const count = await runProjections(o.date, props);
    console.log(`wrote ${count} projection(s) for ${o.date} (model ${MODEL_VERSION})`);
  });

/**
 * Formats a given Date object into a string representing the time in UTC.
 *
 * @param {Date} d - The Date object to format.
 * @return {string} A string in the format "HH:mm UTC" representing the time in UTC.
 */
function fmtUtc(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/**
 * Processes and transforms input options into a structured PullOptions object.
 *
 * @param {Object} o - The input options object.
 * @param {string} o.books - A comma-separated string of book names.
 * @param {string} o.sharp - A string representing sharp details, trimmed of whitespace.
 * @param {string} o.regions - A string representing region data, trimmed of whitespace.
 * @param {string} o.edge - A string representing the edge threshold, which will be converted to a number.
 * @return {PullOptions} A structured object containing processed options including an array of book names,
 *                       trimmed sharp and region strings, and a numeric edge threshold.
 */
function pullOptions(o: { books: string; sharp: string; regions: string; edge: string }): PullOptions {
  return {
    books: o.books.split(',').map((s) => s.trim()).filter(Boolean),
    sharp: o.sharp.trim(),
    regions: o.regions.trim(),
    edgeThreshold: Number(o.edge),
  };
}

/**
 * Defines a command named 'lines' within the program.
 *
 * This command can be used to execute functionality related to the concept or feature of "lines".
 */
const lines = program.command('lines');
lines
  .command('pull')
  .description('pull market lines, store them, and log edge picks vs projections')
  .requiredOption('--date <YYYY-MM-DD>', 'slate date')
  .option('--books <keys>', 'comma-separated bookmaker keys to store', 'draftkings,fanduel')
  .option('--sharp <key>', 'reference/sharp bookmaker key (preferred for pricing)', 'pinnacle')
  .option('--regions <regions>', 'odds regions (pinnacle needs eu)', 'us')
  .option('--edge <pct>', 'minimum |model - fair| to log a pick', '0.03')
  .action(async (o: { date: string; books: string; sharp: string; regions: string; edge: string }) => {
    const r = await pullLines(o.date, pullOptions(o));
    console.log(
      `Odds API events: ${r.oddsEvents} | DB games for ${o.date}: ${r.dbGames} | matched: ${r.matchedEvents}`,
    );
    console.log(
      `stored ${r.linesStored} line(s); wrote ${r.picksWritten} pick(s); ` +
        `${r.unmatchedPlayers} unmatched player name(s)`,
    );
    if (r.skippedStartedGames > 0) {
      console.log(
        `skipped ${r.skippedStartedGames} matched event(s) whose game had already started ` +
          '— a price quoted after first pitch is a live in-game price, not a market you can bet',
      );
    }
    if (r.matchedEvents === 0) {
      if (r.oddsEvents === 0) {
        console.log(
          'Hint: the Odds API returned no events. It only covers current/upcoming games — ' +
            `${o.date} may be in the past or have no slate.`,
        );
      } else if (r.dbGames === 0) {
        console.log(`Hint: no games in the DB for ${o.date}. Run: npm run ingest -- schedule --date ${o.date}`);
      } else {
        console.log('Hint: events and DB games both exist but none matched — likely a team-name mismatch.');
      }
    } else if (r.skippedStartedGames === r.matchedEvents) {
      console.log(
        `Hint: all ${r.matchedEvents} matched event(s) had already started, so nothing was stored. ` +
          'Run `lines pull` before first pitch.',
      );
    } else if (r.picksWritten === 0 && r.linesStored > 0) {
      console.log('Hint: lines stored but no edges. Run `project` for this date first, or lower --edge.');
    }
  });
lines
  .command('capture')
  .description('capture closing lines and compute CLV on this slate\'s picks')
  .requiredOption('--date <YYYY-MM-DD>', 'slate date')
  .option('--books <keys>', 'comma-separated bookmaker keys', 'draftkings,fanduel')
  .option('--sharp <key>', 'reference/sharp bookmaker key', 'pinnacle')
  .option('--regions <regions>', 'odds regions', 'us')
  .option('--edge <pct>', 'unused for capture', '0.03')
  .action(async (o: { date: string; books: string; sharp: string; regions: string; edge: string }) => {
    const r = await captureClosing(o.date, pullOptions(o));
    if (!r.fetched) {
      if (r.gamesStarted === 0) {
        console.log(`no games for ${o.date} — 0 upcoming, 0 started; nothing to capture, 0 API credits spent`);
        console.log(`Hint: no games in the DB for ${o.date}. Run: npm run ingest -- schedule --date ${o.date}`);
      } else {
        console.log(
          `no upcoming games for ${o.date} — all ${r.gamesStarted} game(s) have started; ` +
            `skipped ${r.skipped} pick(s), 0 API credits spent`,
        );
      }
      return;
    }
    console.log(
      `captured ${r.updated} pick(s)` +
        (r.skipped > 0 ? `; skipped ${r.skipped} on ${r.gamesStarted} game(s) already started` : ''),
    );
    if (r.nextFirstPitch != null && r.lastFirstPitch != null) {
      const mins = Math.round((r.nextFirstPitch.getTime() - Date.now()) / 60000);
      console.log(`next first pitch ${fmtUtc(r.nextFirstPitch)} (in ${mins}m) · last ${fmtUtc(r.lastFirstPitch)}`);
    }
  });
lines
  .command('reprice')
  .description('re-price stored lines against current projections (no API calls)')
  .requiredOption('--date <YYYY-MM-DD>', 'slate date to re-price')
  .option('--edge <pct>', 'minimum |model - fair| to log a pick', '0.03')
  .option('--force', 'reprice even though it will destroy captured closing lines')
  .action(async (o: { date: string; edge: string; force?: boolean }) => {
    const r = await repriceLines(o.date, Number(o.edge), Boolean(o.force));
    if (r.refused) {
      const skippedNote =
        r.startedGamesSkipped > 0
          ? `${r.startedGamesSkipped} other started game(s) on this slate are unaffected and already skipped. `
          : '';
      console.error(
        `refusing to reprice ${o.date}: ${r.capturedCount} pick(s) on upcoming, not-yet-started game(s) ` +
          `have a captured closing line that repricing would delete, and closing lines cannot be recaptured ` +
          `once a game starts. ${skippedNote}Re-run with --force if you are sure.`,
      );
      process.exitCode = 1;
      return;
    }
    const destroyed = r.capturedCount > 0 ? `; destroyed ${r.capturedCount} captured closing line(s)` : '';
    const skipped = r.startedGamesSkipped > 0 ? `; skipped ${r.startedGamesSkipped} started game(s)` : '';
    console.log(
      `re-priced ${r.linesRead} stored line(s); wrote ${r.picksWritten} pick(s) — 0 API credits${skipped}${destroyed}`,
    );
    if (r.linesRead === 0 && r.startedGamesSkipped > 0) {
      console.log(
        `Hint: every game with stored lines on ${o.date} has started; nothing is still bettable, ` +
          'and existing picks were left untouched.',
      );
    }
  });

/**
 *  Defines a command named 'settle' within the program.
 *
 *  This command is used to grade settled picks against actual box-score outcomes.
 *
 *  It requires a date option to specify the slate date for which the grading should be performed.
 */
program
  .command('settle')
  .description('grade settled picks against actual box-score outcomes')
  .requiredOption('--date <YYYY-MM-DD>', 'slate date (games must be Final and ingested)')
  .action(async (o: { date: string }) => {
    const n = await settleResults(o.date);
    console.log(`settled ${n} pick(s) for ${o.date}`);
  });

/**
 *  Defines a command named 'backfill' within the program.
 *
 *  This command is used to project a date range and evaluate finished games vs reality (model calibration).
 */
program
  .command('backfill')
  .description('project a date range and evaluate finished games vs reality (model calibration)')
  .requiredOption('--from <YYYY-MM-DD>', 'start date (inclusive)')
  .requiredOption('--to <YYYY-MM-DD>', 'end date (inclusive)')
  .option('--prop <kind>', PROP_HELP, 'all')
  .action(async (o: { from: string; to: string; prop: string }) => {
    const props = parseProps(o.prop);
    if (props.length === 0) {
      console.error(`unknown --prop "${o.prop}". Use: ${PROP_HELP}`);
      process.exitCode = 1;
      return;
    }
    let r;
    try {
      r = await backfill(o.from, o.to, props);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    console.log(`backfilled ${r.dates} date(s): ${r.projected} projection(s), ${r.evals} model eval(s)`);
  });

/**
 *  Defines a command named 'backtest' within the program.
 *
 *  This command is used to report model calibration (reliability + ECE + Brier) from model_evals.
 */
program
  .command('backtest')
  .description('report model calibration (reliability + ECE + Brier) from model_evals')
  .action(async () => {
    await backtestReport();
  });

/**
 * Defines a command named 'health' within the program.
 *
 * This command is used to report data sufficiency, including date coverage, sample vs shrinkage, and evaluation counts.
 *
 * The action associated with this command generates a health report when executed.
 */
program
  .command('health')
  .description('data sufficiency: date coverage, sample vs shrinkage, eval counts')
  .action(async () => {
    await healthReport();
  });

/**
 * Defines a command named 'clv' within the program.
 *
 * This command is used to report the closing line value (CLV) on settled picks.
 *
 * The action associated with this command generates a CLV report when executed.
 */
program
  .command('clv')
  .description('report closing line value on settled picks')
  .action(async () => {
    await clvReport();
  });
program
  .command('calibrate')
  .description('reliability diagram on settled picks')
  .action(async () => {
    await calibrationReport();
  });

/**
 * Hooks into the program's lifecycle to perform cleanup actions after all commands have been executed.
 *
 * This hook ensures that the database connection pool is properly closed when the program finishes executing,
 * preventing potential resource leaks and ensuring a clean shutdown of the application.
 */
program.hook('postAction', async () => {
  await pool.end();
});

/**
 * Parses the command-line arguments and executes the corresponding actions defined in the program.
 *
 * If an error occurs during parsing or execution, it logs the error to the console and exits the process with a non-zero status code.
 */
program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
