import { Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../config/config';

/** Keyed hash for identifiers in logs: an identifier typed in the sign-in box may be a password, so it is never stored as typed. */
@Injectable()
export class LogHmacService {
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = Buffer.from(config.logHmacKey, 'utf8');
  }

  /** 16 hex characters: enough to group repeated attempts, too short to be a dictionary oracle on its own. */
  mask(value: string): string {
    return createHmac('sha256', this.key).update(value.trim().toLowerCase()).digest('hex').slice(0, 16);
  }
}
