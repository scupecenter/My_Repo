import { Logger } from '@nestjs/common';
import { json } from 'express';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { appModuleFor } from './app.module';
import { requestIdMiddleware, securityHeaders } from './common/request-id';
import { MaintenanceService } from './settings/maintenance.service';
import type { AppConfig } from './config/config';

export const API_PREFIX = 'api/v1';

/** Builds the HTTP app. main.ts listens on it; the tests call it with a test configuration. */
export async function createApp(config: AppConfig, opts: { logger?: boolean } = {}): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(appModuleFor(config), {
    logger: opts.logger === false ? false : ['error', 'warn', 'log'],
    bodyParser: true,
  });
  app.disable('x-powered-by');
  // nginx sits in front on this host: believe X-Forwarded-For from the loopback address only.
  app.set('trust proxy', 'loopback');
  app.useBodyParser('json', { limit: '100kb' });
  // SEC-3: browsers send CSP reports as application/csp-report or application/reports+json. Parsed on that one path only; every other route keeps JSON only.
  app.use(`/${API_PREFIX}/csp-report`, json({ type: ['application/csp-report', 'application/reports+json'], limit: '16kb' }));
  app.use(requestIdMiddleware);
  app.use(securityHeaders);
  // 0146: while a project data reset runs, every route but the progress reads answers 503 (before the session guard and the request transaction)
  app.use(app.get(MaintenanceService).middleware());
  app.setGlobalPrefix(API_PREFIX);
  if (opts.logger !== false) {
    const log = new Logger('http');
    app.use((req: { method: string; originalUrl: string; id?: string }, res: { statusCode: number; on(e: string, f: () => void): void }, next: () => void) => {
      const t0 = Date.now();
      res.on('finish', () => log.log(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Date.now() - t0}ms request_id=${req.id ?? ''}`));
      next();
    });
  }
  return app;
}
