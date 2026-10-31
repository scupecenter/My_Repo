import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './app.factory';
import { loadConfig } from './config/config';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
  new Logger('main').log(`GSDN PMIS API listening on ${config.host}:${config.port}`);
}

main().catch((e: unknown) => {
  // Configuration errors name the setting, never its value.
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
