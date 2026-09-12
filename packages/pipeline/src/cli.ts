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

// Shared by `project` and `backfill` so the two commands can never accept
// different prop sets.
const PROP_HELP = `${ALL_PROPS.join(' | ')} | all`;

function parseProps(arg: string): PropKind[] {
  if (arg === 'all') return [...ALL_PROPS];
  return (ALL_PROPS as readonly string[]).includes(arg) ? [arg as PropKind] : [];
}

// Ingest commands accept either a single --date or a --from/--to range, but
// not a mix: --date plus either range flag is ambiguous (which did the user
// mean?), and a lone --from or --to is a dangling/typo'd range.
//
// - A dangling range flag, or nothing at all, returns [] -- genuinely "you
//   gave me nothing usable" -- so the caller can print the generic
//   "give either --date, or both --from and --to" message.
// - --date combined with any range flag, and an invalid complete range
//   (reversed or unparseable, via dateRange), both THROW instead: the user
//   supplied something, just something wrong, so a specific message is
//   accurate where the generic one would misleadingly imply nothing was
//   given. Callers must catch and print err.message.
function parseDates(o: { date?: string; from?: string; to?: string }): string[] {
  const hasRange = Boolean(o.from || o.to);
  if (o.date && hasRange) {
    throw new Error('give either --date or --from/--to, not both');
  }
  if (hasRange) return o.from && o.to ? dateRange(o.from, o.to) : [];
  return o.date ? [o.date] : [];
}

// Shared by the ingest commands: resolve --date/--from/--to, printing the
// right message (specific for a thrown parseDates error, generic for an
// empty result) and setting a non-zero exit code either way. Returns null
// when the caller should bail out.
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

// Run `fn` per date, continuing past failures: one bad date must not abort a
// 120-day pull. Returns the totals so the caller can report honestly.
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

const program = new Command();
program
  .name('mlb-edge')
  .description('MLB prop edge-finding pipeline (ingestion + CLV/calibration scaffold)');

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

// Game times are stored as timestamptz; report them in UTC so the output does
// not silently change meaning with the operator's local timezone.
function fmtUtc(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

function pullOptions(o: { books: string; sharp: string; regions: string; edge: string }): PullOptions {
  return {
    books: o.books.split(',').map((s) => s.trim()).filter(Boolean),
    sharp: o.sharp.trim(),
    regions: o.regions.trim(),
    edgeThreshold: Number(o.edge),
  };
}

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
      console.log(
        `no upcoming games for ${o.date} — all ${r.gamesStarted} game(s) have started; ` +
          `skipped ${r.skipped} pick(s), 0 API credits spent`,
      );
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
  .action(async (o: { date: string; edge: string }) => {
    const r = await repriceLines(o.date, Number(o.edge));
    console.log(`re-priced ${r.linesRead} stored line(s); wrote ${r.picksWritten} pick(s) — 0 API credits`);
  });

program
  .command('settle')
  .description('grade settled picks against actual box-score outcomes')
  .requiredOption('--date <YYYY-MM-DD>', 'slate date (games must be Final and ingested)')
  .action(async (o: { date: string }) => {
    const n = await settleResults(o.date);
    console.log(`settled ${n} pick(s) for ${o.date}`);
  });

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

program
  .command('backtest')
  .description('report model calibration (reliability + ECE + Brier) from model_evals')
  .action(async () => {
    await backtestReport();
  });

program
  .command('health')
  .description('data sufficiency: date coverage, sample vs shrinkage, eval counts')
  .action(async () => {
    await healthReport();
  });

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

program.hook('postAction', async () => {
  await pool.end();
});

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
