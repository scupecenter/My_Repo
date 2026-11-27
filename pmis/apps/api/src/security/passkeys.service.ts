import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RateLimiter } from '../auth/rate-limiter';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { TwoFactorService } from '../auth/two-factor.service';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { parse } from '../common/zod';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import {
  authenticationOptions, finishAuthentication, finishRegistration, publicKeyFromText, publicKeyToText, registrationOptions, type RpConfig,
} from './webauthn';

const SETTING_PER_MINUTE = 10;
const ENROL_PER_MINUTE = 10;
const reason = z.string().trim().min(3).max(900);
const assertion = z.record(z.string(), z.unknown()).refine((o) => typeof o.id === 'string' && typeof o.response === 'object' && o.response !== null, { message: 'not a WebAuthn response' });
const putBody = z.object({ enabled: z.boolean(), reason }).strict();
const verifyBody = z.object({ label: z.string().trim().min(1).max(80), response: assertion }).strict();
export const passkeySignInBody = z.object({ response: assertion }).strict();
const revokeBody = z.object({ reason }).strict();

export interface PasskeySettingDto { enabled: boolean; ready: boolean; updated_at: string | null; updated_by: unknown; version: number; can_edit: boolean }
export interface PasskeyItem { id: string; label: string; created_at: string; last_used_at: string | null; device_type: string; backed_up: boolean }

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
/** The challenge the browser signed sits in clientDataJSON; the stored hash is how the single-use challenge is found again. */
function challengeOf(response: Record<string, unknown>): string | null {
  try {
    const r = response.response as Record<string, unknown>;
    const cd = JSON.parse(Buffer.from(String(r.clientDataJSON), 'base64url').toString('utf8')) as { challenge?: unknown };
    return typeof cd.challenge === 'string' && /^[A-Za-z0-9_-]{16,200}$/.test(cd.challenge) ? cd.challenge : null;
  } catch { return null; }
}

/**
 * Passkeys (migration 0294, contract 0.15.194): an optional alternative to the authenticator-app code at the second step. Off until a System Admin turns it on, never
 * forced, never the only way in. The WebAuthn checks run through src/security/webauthn.ts; the single-use challenge and the sign counter are enforced in the database.
 */
@Injectable()
export class PasskeyService {
  constructor(
    private readonly db: DbService,
    private readonly stepUp: StepUpService,
    private readonly limiter: RateLimiter,
    private readonly twoFactor: TwoFactorService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The relying party comes from the public address of the workspace (APP_BASE_URL). Not set, or not https (other than localhost): the feature cannot be used. */
  rp(): RpConfig | null {
    const base = this.config.appBaseUrl;
    if (!base) return null;
    try {
      const u = new URL(base);
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null;
      return { rpId: u.hostname, rpName: 'GSDN Workspace', origins: [u.origin] };
    } catch { return null; }
  }

  private need(): RpConfig {
    const rp = this.rp();
    if (!rp) throw new ProblemException(409, 'invalid_transition', { detail: 'Passkeys need the public address of the workspace (APP_BASE_URL, https).' });
    return rp;
  }

  // ------------------------------------------------------------------ admin side
  async getSetting(): Promise<PasskeySettingDto> {
    const rows = await this.db.tx.$queryRaw<{ r: Omit<PasskeySettingDto, 'ready'> }[]>(Prisma.sql`SELECT passkey_state() AS r`);
    return { ...rows[0]!.r, ready: this.rp() !== null };
  }

  async setSetting(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<PasskeySettingDto> {
    const b = parse(putBody, raw);
    const etag = parseIfMatch(ifMatch);
    const wait = this.limiter.hit(`passkey-setting:${auth.user.id}`, SETTING_PER_MINUTE);
    if (wait) throw problems.rateLimited(wait);
    await this.stepUp.require(auth);
    if (b.enabled) this.need();
    const rows = await this.db.tx.$queryRaw<{ r: Omit<PasskeySettingDto, 'ready'> }[]>(Prisma.sql`SELECT admin_set_passkeys(${b.enabled}::boolean, ${b.reason}::text, ${etag}::int) AS r`);
    return { ...rows[0]!.r, ready: this.rp() !== null };
  }

  /** POST /users/{id}/passkeys/revoke: every passkey of one account (lost device). The authenticator code keeps working. */
  async adminRevoke(auth: AuthContext, userId: string, raw: unknown): Promise<{ revoked: number }> {
    const b = parse(revokeBody, raw);
    const wait = this.limiter.hit(`passkey-admin-revoke:${auth.user.id}`, ENROL_PER_MINUTE);
    if (wait) throw problems.rateLimited(wait);
    await this.stepUp.require(auth);
    const rows = await this.db.tx.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT admin_passkey_revoke(${userId}::uuid, ${b.reason}::text) AS n`);
    return { revoked: rows[0]!.n };
  }

  // ------------------------------------------------------------------ the account holder
  async mine(auth: AuthContext): Promise<{ enabled: boolean; ready: boolean; can_add: boolean; items: PasskeyItem[] }> {
    const st = await this.db.tx.$queryRaw<{ r: { enabled: boolean } }[]>(Prisma.sql`SELECT passkey_state() AS r`);
    const items = await this.db.tx.$queryRaw<{ r: PasskeyItem[] }[]>(Prisma.sql`SELECT passkey_list(${auth.user.id}::uuid) AS r`);
    const tf = await this.twoFactor.state(auth.user.id);
    return { enabled: st[0]!.r.enabled, ready: this.rp() !== null, can_add: tf.required && tf.enrolled, items: items[0]!.r };
  }

  private async needEnabled(): Promise<void> {
    const st = await this.db.tx.$queryRaw<{ r: { enabled: boolean } }[]>(Prisma.sql`SELECT passkey_state() AS r`);
    if (st[0]!.r.enabled !== true) throw new ProblemException(409, 'invalid_transition', { detail: 'Passkeys are not turned on.' });
  }

  private async needTwoFactor(userId: string): Promise<void> {
    const tf = await this.twoFactor.state(userId);
    if (!(tf.required && tf.enrolled)) {
      throw new ProblemException(409, 'invalid_transition', { detail: 'A passkey is added next to the authenticator code. Turn on two-step verification first.' });
    }
  }

  async registerOptions(auth: AuthContext): Promise<Record<string, unknown>> {
    const rp = this.need();
    const wait = this.limiter.hit(`passkey-enrol:${auth.user.id}`, ENROL_PER_MINUTE);
    if (wait) throw problems.rateLimited(wait);
    await this.stepUp.require(auth);
    await this.needEnabled();
    await this.needTwoFactor(auth.user.id);
    const creds = await this.db.tx.$queryRaw<{ credential_id: string }[]>(Prisma.sql`SELECT credential_id FROM auth_passkey_creds(${auth.user.id}::uuid)`);
    const o = await registrationOptions(rp, { id: auth.user.id, name: auth.user.email, displayName: auth.user.displayName }, creds.map((c) => c.credential_id));
    await this.db.tx.$queryRaw(Prisma.sql`SELECT auth_passkey_challenge_create(${auth.user.id}::uuid, ${sha(o.challenge)}::text, 'register') AS until`);
    return o as unknown as Record<string, unknown>;
  }

  async registerVerify(auth: AuthContext, raw: unknown): Promise<PasskeyItem> {
    const rp = this.need();
    const b = parse(verifyBody, raw);
    const wait = this.limiter.hit(`passkey-enrol:${auth.user.id}`, ENROL_PER_MINUTE);
    if (wait) throw problems.rateLimited(wait);
    await this.stepUp.require(auth);
    await this.needEnabled();
    await this.needTwoFactor(auth.user.id);
    const ch = challengeOf(b.response);
    const taken = ch ? await this.db.tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`SELECT auth_passkey_challenge_take(${auth.user.id}::uuid, ${sha(ch)}::text, 'register') AS ok`) : [];
    if (!ch || taken[0]?.ok !== true) throw new ProblemException(400, 'validation_failed', { detail: 'This passkey request expired. Start again.' });
    const np = await finishRegistration(rp, b.response, ch);
    if (!np) throw new ProblemException(400, 'validation_failed', { detail: 'The passkey could not be verified.' });
    const rows = await this.db.tx.$queryRaw<{ r: PasskeyItem }[]>(Prisma.sql`SELECT passkey_add(${np.credentialId}::text, ${publicKeyToText(np.publicKey)}::text,
      ${np.signCount}::bigint, ${np.transports}::text[], ${np.deviceType}::text, ${np.backedUp}::boolean, ${b.label}::text) AS r`);
    return rows[0]!.r;
  }

  async removeMine(auth: AuthContext, id: string): Promise<void> {
    const wait = this.limiter.hit(`passkey-enrol:${auth.user.id}`, ENROL_PER_MINUTE);
    if (wait) throw problems.rateLimited(wait);
    await this.stepUp.require(auth);
    const rows = await this.db.tx.$queryRaw<{ r: boolean }[]>(Prisma.sql`SELECT passkey_revoke(${id}::uuid) AS r`);
    if (!rows[0]!.r) throw problems.notFound();
  }

  // ------------------------------------------------------------------ sign-in (inside a transaction whose signed context names the user)
  /** Options for the second step, or null when the account has no active passkey (or the feature is off): the page then shows only the code. */
  async signInOptions(userId: string): Promise<Record<string, unknown> | null> {
    const rp = this.rp();
    if (!rp) return null;
    const creds = await this.db.tx.$queryRaw<{ credential_id: string }[]>(Prisma.sql`SELECT credential_id FROM auth_passkey_creds(${userId}::uuid)`);
    if (creds.length === 0) return null;
    const o = await authenticationOptions(rp, creds.map((c) => c.credential_id));
    await this.db.tx.$queryRaw(Prisma.sql`SELECT auth_passkey_challenge_create(${userId}::uuid, ${sha(o.challenge)}::text, 'authenticate') AS until`);
    return o as unknown as Record<string, unknown>;
  }

  /** ok, or a reason: bad (does not verify or unknown key or expired challenge) | clone (the counter did not move forward). */
  async signInVerify(userId: string, response: Record<string, unknown>): Promise<'ok' | 'bad' | 'clone'> {
    const rp = this.rp();
    const ch = challengeOf(response);
    if (!rp || !ch) return 'bad';
    const taken = await this.db.tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`SELECT auth_passkey_challenge_take(${userId}::uuid, ${sha(ch)}::text, 'authenticate') AS ok`);
    if (taken[0]?.ok !== true) return 'bad';
    const creds = await this.db.tx.$queryRaw<{ credential_id: string; public_key: string; sign_count: bigint; transports: string[] }[]>(
      Prisma.sql`SELECT credential_id, public_key, sign_count, transports FROM auth_passkey_creds(${userId}::uuid)`);
    const c = creds.find((x) => x.credential_id === response.id);
    if (!c) return 'bad';
    const v = await finishAuthentication(rp, response, ch, { credentialId: c.credential_id, publicKey: publicKeyFromText(c.public_key), signCount: Number(c.sign_count), transports: c.transports });
    if (!v) return 'bad';
    const used = await this.db.tx.$queryRaw<{ r: string }[]>(Prisma.sql`SELECT auth_passkey_used(${userId}::uuid, ${c.credential_id}::text, ${v.newCounter}::bigint) AS r`);
    return used[0]!.r === 'ok' ? 'ok' : used[0]!.r === 'clone' ? 'clone' : 'bad';
  }
}
