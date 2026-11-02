import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { ProblemException } from '../common/problem';
import type { AuthContext } from './auth.types';

const DEFAULT_MAX_AGE_S = 300;

/** Step-up (ADR 0002 section 6, ADR 0012 section 6): the last password check must be within stepup_max_age_seconds. */
@Injectable()
export class StepUpService {
  private cached: { at: number; seconds: number } | undefined;

  constructor(private readonly db: DbService) {}

  /** Setting `stepup_max_age_seconds` (default 300), read from the settings table, cached for a minute. */
  async maxAgeSeconds(): Promise<number> {
    if (this.cached && Date.now() - this.cached.at < 60_000) return this.cached.seconds;
    let seconds = DEFAULT_MAX_AGE_S;
    try {
      const rows = await this.db.client.$queryRaw<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'stepup_max_age_seconds'`;
      const v = rows[0]?.value;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 30 && v <= 3600) seconds = v;
    } catch {
      /* keep the default */
    }
    this.cached = { at: Date.now(), seconds };
    return seconds;
  }

  async validUntil(auth: AuthContext): Promise<Date | null> {
    if (!auth.session.stepupAt) return null;
    const until = new Date(auth.session.stepupAt.getTime() + (await this.maxAgeSeconds()) * 1000);
    return until.getTime() > auth.session.dbNow.getTime() ? until : null;
  }

  /** Throws 401 step_up_required unless the session was re-authenticated recently. */
  async require(auth: AuthContext): Promise<void> {
    if (await this.validUntil(auth)) return;
    let method: 'password' | 'password_totp' | 'm365' = auth.session.authMethod === 'local' ? 'password' : 'm365';
    if (method === 'password') {
      // Two-factor on: the dialog asks for the password and the code together.
      const rows = await this.db.tx.$queryRaw<{ needs: boolean }[]>`SELECT (required AND enrolled) AS needs FROM auth_totp_state(${auth.user.id}::uuid)`;
      if (rows[0]?.needs) method = 'password_totp';
    }
    throw new ProblemException(401, 'step_up_required', {
      detail: method === 'password_totp' ? 'Confirm your password and a code from your authenticator app to continue.' : 'Confirm your password to continue.',
      step_up_method: method,
    });
  }
}
