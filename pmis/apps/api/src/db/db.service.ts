import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { APP_CONFIG, AppConfig } from '../config/config';

export type Tx = Prisma.TransactionClient;

interface TxStore {
  tx: Tx;
}
const als = new AsyncLocalStorage<TxStore>();

/**
 * The only door to the database. Inside a request, `tx` is the request transaction that already carries
 * app.user_id and app.region_ids (set_config, transaction-local). Outside one it is the plain client.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
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

  /** Runs `fn` with `tx` as the ambient transaction client. */
  runIn<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
    return als.run({ tx }, fn);
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.$disconnect();
    } catch {
      /* the database was never reachable: nothing to close */
    }
  }
}
