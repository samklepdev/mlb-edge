import { Command } from 'commander';
import { pool } from '@mlb-edge/db';
import { migrate } from './db/migrate.js';
import { ingestSchedule } from './ingest/schedule.js';
import { ingestFinalGames, ingestBoxscore } from './ingest/games.js';
import { seedDemo } from './seed/demo.js';
import { runProjections, type PropKind } from './project/index.js';
import { MODEL_VERSION } from './project/model.js';
import { pullLines, captureClosing, settleResults, type PullOptions } from './market/lines.js';
import { clvReport } from './clv/index.js';
import { calibrationReport } from './calibration/index.js';

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
  .requiredOption('--date <YYYY-MM-DD>', 'date to pull')
  .action(async (o: { date: string }) => {
    const n = await ingestSchedule(o.date);
    console.log(`ingested ${n} games for ${o.date}`);
  });
ingest
  .command('games')
  .description('pull boxscores for FINAL games already stored for a date')
  .requiredOption('--date <YYYY-MM-DD>', 'date to pull finals for')
  .action(async (o: { date: string }) => {
    const n = await ingestFinalGames(o.date);
    console.log(`ingested boxscores for ${n} final game(s)`);
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
  .option('--prop <kind>', 'total_bases | strikeouts | all', 'all')
  .action(async (o: { date: string; prop: string }) => {
    const valid: PropKind[] = ['total_bases', 'strikeouts'];
    const props: PropKind[] =
      o.prop === 'all' ? valid : valid.includes(o.prop as PropKind) ? [o.prop as PropKind] : [];
    if (props.length === 0) {
      console.error(`unknown --prop "${o.prop}". Use: total_bases | strikeouts | all`);
      process.exitCode = 1;
      return;
    }
    const count = await runProjections(o.date, props);
    console.log(`wrote ${count} projection(s) for ${o.date} (model ${MODEL_VERSION})`);
  });

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
    const n = await captureClosing(o.date, pullOptions(o));
    console.log(`updated closing line + CLV on ${n} pick(s) for ${o.date}`);
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
