import { Command } from 'commander';
import { pool } from '@mlb-edge/db';
import { migrate } from './db/migrate.js';
import { ingestSchedule } from './ingest/schedule.js';
import { ingestFinalGames, ingestBoxscore } from './ingest/games.js';
import { seedDemo } from './seed/demo.js';
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
