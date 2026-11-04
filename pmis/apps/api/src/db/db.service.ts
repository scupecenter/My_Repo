import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { APP_CONFIG, AppConfig } from '../config/config';
import type { RequestContext } from '../logs/context';
import { parseContextKey, setContextKey } from './session-context';

export type Tx = Prisma.TransactionClient;

interface TxStore {
  tx: Tx;
  /** The context the transaction began with (migration 0069), so a side transaction of the same request can begin the same one. */
  ctx?: RequestContext;
}
const als = new AsyncLocalStorage<TxStore>();

/**
 * The only door to the database. Inside a request, `tx` is the request transaction that already carries
 * the verified session context (app_begin, migration 0069). Outside one it is the plain client.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const key = parseContextKey(config.contextKey);
    if (!key) throw new Error('PMIS_CONTEXT_KEY is missing or not 64 hex characters');
    setContextKey(key);
    const client = new PrismaClient({ datasourceUrl: config.databaseUrl, log: [{ emit: 'event', level: 'error' }] });
    // A refusal of the workflow engine (wf:<code>:<json>, for example a stale If-Match) is an answer to the caller, not a server error.
    client.$on('error', (e) => {
      if (/wf:[a-z_]+:\{|ERROR: matrix: /.test(e.message)) return; // matrix_save refuses a missing right with a "matrix: ..." message (403 for the caller)
      process.stderr.write(`prisma:error ${e.message}\n`);
    });
    this.client = client;
  }

  get tx(): Tx {
    return als.getStore()?.tx ?? this.client;
  }

  get inRequestTx(): boolean {
    return als.getStore() !== undefined;
  }

  /** The context the ambient request transaction began with (undefined outside a request). */
  get requestContext(): RequestContext | undefined {
    return als.getStore()?.ctx;
  }

  /** Runs `fn` with `tx` as the ambient transaction client. */
  runIn<T>(tx: Tx, fn: () => Promise<T>, ctx?: RequestContext): Promise<T> {
    return als.run({ tx, ctx }, fn);
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.$disconnect();
    } catch {
      /* the database was never reachable: nothing to close */
    }
  }
}
