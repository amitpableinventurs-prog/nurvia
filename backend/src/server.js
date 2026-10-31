import { createApp } from './app.js';
import { connectDb, disconnectDb } from './config/db.js';
import { env } from './config/env.js';
import { startReminderJob } from './jobs/reminders.js';

await connectDb();
const server = createApp().listen(env.port, () => {
  console.info(`Nurvia API listening on :${env.port} (${env.nodeEnv})`);
});
const stopJobs = env.jobs.enabled ? startReminderJob() : () => {};

async function shutdown(signal) {
  console.info(`${signal} received, shutting down`);
  stopJobs();
  server.close(async () => {
    await disconnectDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
