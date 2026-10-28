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
    this.client = new PrismaClient({ datasourceUrl: config.databaseUrl, log: ['error'] });
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
