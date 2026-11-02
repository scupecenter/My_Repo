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

  /**
   * The security-log form of an identifier typed in the sign-in box (contract `SecurityLogEntry.identifier_masked`): `?`, the first character only
   * when the input looks like an email, a 4-digit employee ID or a phone, `***#`, then 12 hex digits of the keyed HMAC of the normalised input.
   * The same input always gives the same value, so repeated attempts group; the text itself (it may be a password) is never kept.
   */
  masked(value: string): string {
    const v = value.trim().toLowerCase();
    const looks = /^[^@\s]+@[^@\s]+$/.test(v) || /^[0-9]{4}$/.test(v) || /^\+?[0-9]{7,15}$/.test(v);
    const first = looks && /^[a-z0-9+]$/i.test(v.charAt(0)) ? v.charAt(0) : '';
    return `?${first}***#${createHmac('sha256', this.key).update(v).digest('hex').slice(0, 12)}`;
  }
}
