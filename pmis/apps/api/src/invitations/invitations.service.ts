import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { AccessService } from "../access/access.service";
import {
  LOGIN_IP_BASE_SECONDS,
  LOGIN_IP_MAX_SECONDS,
  LOGIN_IP_WINDOW_MS,
  LOGIN_LIMIT_PER_IP,
} from "../auth/auth.service";
import type { AuthContext } from "../auth/auth.types";
import { PasswordService } from "../auth/password.service";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  passwordPolicyErrors,
} from "../auth/password.policy";
import { RateLimiter } from "../auth/rate-limiter";
import { StepUpService } from "../auth/step-up.service";
import {
  decodeTypedCursor,
  encodeCursor,
  likePattern,
  parseLimit,
} from "../common/cursor";
import { ProblemException, problems } from "../common/problem";
import { parse, uuidSchema } from "../common/zod";
import { DbService } from "../db/db.service";
import { MailService } from "../mail/mail.service";

const reason = z.string().trim().min(3).max(1000);
const isoDateTime = z.string().datetime({ offset: true });

const assignmentSchema = z
  .object({
    role_id: z.string().uuid(),
    permission_level: z.enum(["view", "entry", "review", "approve", "admin"]),
    team: z.enum(["cw", "te", "both", "none"]).optional(),
    all_regions: z.boolean().optional(),
    region_ids: z.array(z.number().int().min(1).max(7)).max(7).optional(),
    all_modules: z.boolean().optional(),
    module_keys: z.array(z.string().min(1).max(100)).max(100).optional(),
    profile_ids: z.array(z.string().uuid()).max(50).optional(),
    valid_from: isoDateTime.nullish(),
    valid_to: isoDateTime.nullish(),
  })
  .strict();

const createSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    display_name: z.string().trim().min(1).max(200),
    employee_id: z
      .string()
      .regex(/^[0-9]{4}$/)
      .nullish(),
    phone: z
      .string()
      .regex(/^\+[1-9][0-9]{7,14}$/)
      .nullish(),
    assignments: z.array(assignmentSchema).max(20).default([]),
    department_id: z.string().uuid().nullish(),
    manager_id: z.string().uuid().nullish(),
    group_ids: z.array(z.string().uuid()).max(50).default([]),
    require_two_factor: z.boolean().default(false),
    reason,
  })
  .strict();

const reasonOnly = z.object({ reason }).strict();
const acceptSchema = z
  .object({ password: z.string().min(1).max(1024) })
  .strict();

/** The token is 32 random bytes in base64url (43 characters). Anything else cannot be a link we made and never reaches the database. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const sha256Hex = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

interface Ref {
  id: string;
  name: string;
}
export interface InvitationDto {
  id: string;
  email: string;
  display_name: string;
  employee_id: string | null;
  phone: string | null;
  status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: Date;
  created_at: string;
  last_sent_at: Date;
  send_count: number;
  invited_by: Ref;
  reason: string;
  require_two_factor: boolean;
  elevated: boolean;
  department: Ref | null;
  manager: Ref | null;
  groups: Ref[];
  assignments: unknown[];
  accepted_at: Date | null;
  accepted_user_id: string | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

interface Row {
  id: string;
  email: string;
  display_name: string;
  employee_id: string | null;
  phone: string | null;
  status: InvitationDto["status"];
  expires_at: Date;
  created_text: string;
  invited_by: string;
  invited_by_name: string;
  last_sent_at: Date;
  send_count: number;
  require_two_factor: boolean;
  elevated: boolean;
  reason: string;
  department_id: string | null;
  department_name: string | null;
  manager_id: string | null;
  manager_name: string | null;
  groups: Ref[];
  assignments: unknown[];
  accepted_at: Date | null;
  accepted_user_id: string | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  total: bigint;
}

const toDto = (r: Row): InvitationDto => ({
  id: r.id,
  email: r.email,
  display_name: r.display_name,
  employee_id: r.employee_id,
  phone: r.phone,
  status: r.status,
  expires_at: r.expires_at,
  created_at: r.created_text,
  last_sent_at: r.last_sent_at,
  send_count: r.send_count,
  invited_by: { id: r.invited_by, name: r.invited_by_name },
  reason: r.reason,
  require_two_factor: r.require_two_factor,
  elevated: r.elevated,
  department: r.department_id
    ? { id: r.department_id, name: r.department_name ?? "" }
    : null,
  manager: r.manager_id
    ? { id: r.manager_id, name: r.manager_name ?? "" }
    : null,
  groups: r.groups,
  assignments: r.assignments,
  accepted_at: r.accepted_at,
  accepted_user_id: r.accepted_user_id,
  revoked_at: r.revoked_at,
  revoke_reason: r.revoke_reason,
});

/** The text of the invitation mail. It carries the link, which is the secret: the mail is stored as sensitive and never reaches a log. */
export const INVITE_MAIL = {
  invite: (name: string, token: string, until: Date) => ({
    kind: "identity.user_invitation",
    subject: "GSDN Workspace: you are invited to join",
    sensitive: true,
    text:
      `Hello ${name},\n\nYou are invited to GSDN Workspace. Open this link once and choose your password; your account is created with the access an administrator prepared for you:\n` +
      `{{app_url}}/invite/${token}\n\nThe link works once and expires at ${until.toISOString()}. If you did not expect this invitation, ignore this message.\n\n` +
      `تمت دعوتك للانضمام إلى نظام GSDN Workspace. افتح الرابط أعلاه مرة واحدة واختر كلمة المرور، وسيُنشأ حسابك بالصلاحيات التي جهّزها لك المسؤول. ` +
      "الرابط يعمل مرة واحدة وينتهي في الموعد المذكور أعلاه. إن لم تتوقع هذه الدعوة فتجاهل الرسالة.\n",
  }),
};

type Query = Record<string, unknown>;
const one = (q: Query, k: string): string | undefined =>
  typeof q[k] === "string" ? (q[k] as string) : undefined;

/**
 * Invitations (decision 5, migration 0091). The database decides every right (inv_* functions, SECURITY DEFINER); the API makes the token, sends the mail,
 * asks for the step-up when the invitation is elevated and, for the two public routes, rate-limits and answers every failure the same way.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly mail: MailService,
    private readonly passwords: PasswordService,
    private readonly limiter: RateLimiter,
  ) {}

  private static newToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString("base64url");
    return { token, hash: sha256Hex(token) };
  }

  /** The canonical form stored in user_invitations.assignments: every key present, region and module lists only when not "all". */
  private static canonical(
    a: z.infer<typeof assignmentSchema>,
    i: number,
  ): Record<string, unknown> {
    const allRegions = a.all_regions === true;
    const allModules = a.all_modules === true;
    const regions = [...new Set(a.region_ids ?? [])];
    const modules = [...new Set(a.module_keys ?? [])];
    const errors = [];
    if (allRegions && regions.length > 0)
      errors.push({
        path: `/assignments/${i}/region_ids`,
        code: "conflict",
        message: "Choose all regions or a list, not both.",
      });
    if (!allRegions && regions.length === 0)
      errors.push({
        path: `/assignments/${i}/region_ids`,
        code: "required",
        message: "Choose at least one region or all regions.",
      });
    if (allModules && modules.length > 0)
      errors.push({
        path: `/assignments/${i}/module_keys`,
        code: "conflict",
        message: "Choose all modules or a list, not both.",
      });
    if (!allModules && modules.length === 0)
      errors.push({
        path: `/assignments/${i}/module_keys`,
        code: "required",
        message: "Choose at least one module or all modules.",
      });
    if (errors.length > 0) throw problems.validation(errors);
    return {
      role_id: a.role_id,
      permission_level: a.permission_level,
      team: a.team ?? "none",
      all_regions: allRegions,
      region_ids: regions,
      all_modules: allModules,
      module_keys: modules,
      profile_ids: [...new Set(a.profile_ids ?? [])],
      valid_from: a.valid_from ?? null,
      valid_to: a.valid_to ?? null,
    };
  }

  // ------------------------------------------------------------------ admin routes
  async list(
    q: Query,
  ): Promise<{
    items: InvitationDto[];
    page: { limit: number; next_cursor: string | null; total: number };
  }> {
    await this.access.requireAdmin("users", "create");
    const limit = parseLimit(one(q, "limit"));
    const cursor = decodeTypedCursor(one(q, "cursor"), ["ts", "uuid"]);
    const status = one(q, "status");
    if (
      status !== undefined &&
      !["pending", "accepted", "revoked", "expired"].includes(status)
    ) {
      throw problems.validation([
        { path: "/status", code: "invalid", message: "Unknown status." },
      ]);
    }
    const text = one(q, "q")?.trim();
    const rows = await this.read(
      null,
      status ?? null,
      text ? likePattern(text) : null,
      cursor?.[0] ?? null,
      cursor?.[1] ?? null,
      limit + 1,
    );
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items: items.map(toDto),
      page: {
        limit,
        next_cursor:
          rows.length > limit && last
            ? encodeCursor([last.created_text, last.id])
            : null,
        total: Number(rows[0]?.total ?? 0),
      },
    };
  }

  private async read(
    id: string | null,
    status: string | null,
    q: string | null,
    afterTs: string | null,
    afterId: string | null,
    limit: number,
  ): Promise<Row[]> {
    return this.db.tx.$queryRaw<Row[]>(Prisma.sql`
      SELECT id::text AS id, email, display_name, employee_id, phone, status, expires_at, log_ts_text(created_at) AS created_text, invited_by::text AS invited_by, invited_by_name,
             last_sent_at, send_count, require_two_factor, elevated, reason, department_id::text AS department_id, department_name, manager_id::text AS manager_id,
             manager_name, groups, assignments, accepted_at, accepted_user_id::text AS accepted_user_id, revoked_at, revoke_reason, total
        FROM inv_read(${id}::uuid, ${status}::text, ${q}::text, ${afterTs}::timestamptz, ${afterId}::uuid, ${limit}::int)`);
  }

  private async one(id: string): Promise<InvitationDto> {
    const rows = await this.read(id, null, null, null, null, 1);
    if (!rows[0]) throw problems.notFound();
    return toDto(rows[0]);
  }

  async create(auth: AuthContext, raw: unknown): Promise<InvitationDto> {
    const body = parse(createSchema, raw);
    await this.access.requireAdmin("users", "create");
    const assignments = body.assignments.map((a, i) =>
      InvitationsService.canonical(a, i),
    );
    const groups = [...new Set(body.group_ids)];
    // inv_elevated raises every refusal inv_create would (rights, ceilings) and says whether the invitation grants admin-level rights: then the step-up comes first.
    const e = await this.db.tx.$queryRaw<{ e: boolean }[]>(Prisma.sql`
      SELECT inv_elevated(${JSON.stringify(assignments)}::jsonb, ${groups}::uuid[], ${body.manager_id ?? null}::uuid, ${body.department_id ?? null}::uuid,
        ${body.require_two_factor}::boolean) AS e`);
    if (e[0]?.e === true) await this.stepUp.require(auth);
    const { token, hash } = InvitationsService.newToken();
    const made = await this.db.tx.$queryRaw<
      { id: string; expires: Date }[]
    >(Prisma.sql`
      SELECT r_id::text AS id, r_expires AS expires
        FROM inv_create(${body.email}::text, ${body.display_name}::text, ${body.employee_id ?? null}::text, ${body.phone ?? null}::text, ${JSON.stringify(assignments)}::jsonb,
          ${body.department_id ?? null}::uuid, ${body.manager_id ?? null}::uuid, ${groups}::uuid[], ${body.require_two_factor}::boolean, ${hash}::text, ${body.reason}::text)`);
    const row = made[0];
    if (!row) throw new ProblemException(500, "internal_error", {});
    await this.mail.sendToAddress(
      body.email,
      INVITE_MAIL.invite(body.display_name, token, row.expires),
    );
    return this.one(row.id);
  }

  async resend(
    auth: AuthContext,
    id: string,
    raw: unknown,
  ): Promise<InvitationDto> {
    const body = parse(reasonOnly, raw);
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    await this.access.requireAdmin("users", "create");
    const current = await this.one(id);
    if (current.elevated) await this.stepUp.require(auth);
    const { token, hash } = InvitationsService.newToken();
    const r = await this.db.tx.$queryRaw<
      { expires: Date; email: string }[]
    >(Prisma.sql`
      SELECT r_expires AS expires, r_email AS email FROM inv_resend(${id}::uuid, ${hash}::text, ${body.reason}::text)`);
    const row = r[0];
    if (!row) throw new ProblemException(500, "internal_error", {});
    await this.mail.sendToAddress(
      row.email,
      INVITE_MAIL.invite(current.display_name, token, row.expires),
    );
    return this.one(id);
  }

  async revoke(id: string, raw: unknown): Promise<InvitationDto> {
    const body = parse(reasonOnly, raw);
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    await this.access.requireAdmin("users", "create");
    await this.db.tx.$executeRaw(
      Prisma.sql`SELECT inv_revoke(${id}::uuid, ${body.reason}::text)`,
    );
    return this.one(id);
  }

  // ------------------------------------------------------------------ public routes (no session)
  private static invalid(): ProblemException {
    return new ProblemException(404, "invitation_invalid", {
      detail:
        "This invitation link does not work. Ask the person who invited you to send a new one.",
    });
  }

  /**
   * Rate limit like sign-in (per client address, failures only, progressive) and one uniform failure: a link that is unknown, used, revoked, expired or
   * malformed costs the caller a failure and answers the same 404 with the same text.
   */
  private async guarded<T>(
    ip: string | null,
    fn: () => Promise<T | null>,
  ): Promise<T> {
    const key = `invite:ip:${ip ?? "unknown"}`;
    const wait = this.limiter.progressiveWait(
      key,
      LOGIN_LIMIT_PER_IP,
      LOGIN_IP_WINDOW_MS,
      LOGIN_IP_BASE_SECONDS,
      LOGIN_IP_MAX_SECONDS,
    );
    if (wait) throw problems.rateLimited(wait);
    const release = this.limiter.progressiveBegin(key);
    try {
      const r = await fn();
      if (r === null) {
        this.limiter.progressiveFail(key, LOGIN_IP_WINDOW_MS);
        throw InvitationsService.invalid();
      }
      return r;
    } finally {
      release();
    }
  }

  private async peek(
    token: string,
  ): Promise<{
    hash: string;
    display_name: string;
    email: string;
    employee_id: string | null;
    phone: string | null;
    expires_at: Date;
  } | null> {
    if (!TOKEN_RE.test(token)) return null;
    const hash = sha256Hex(token);
    const r = await this.db.client.$queryRaw<
      {
        display_name: string;
        email: string;
        employee_id: string | null;
        phone: string | null;
        expires_at: Date;
      }[]
    >(Prisma.sql`
      SELECT r_display AS display_name, r_email AS email, r_employee_id AS employee_id, r_phone AS phone, r_expires AS expires_at FROM inv_peek(${hash}::text)`);
    return r[0] ? { hash, ...r[0] } : null;
  }

  preview(token: string, ip: string | null) {
    return this.guarded(ip, async () => {
      const p = await this.peek(token);
      if (!p) return null;
      return {
        display_name: p.display_name,
        email: p.email,
        employee_id: p.employee_id,
        phone: p.phone,
        expires_at: p.expires_at,
        password_policy: { min_length: PASSWORD_MIN, max_length: PASSWORD_MAX },
      };
    });
  }

  async accept(
    token: string,
    ip: string | null,
    raw: unknown,
  ): Promise<{ created: true; two_factor_enrolment_pending: boolean }> {
    const body = parse(acceptSchema, raw);
    let conflict = false;
    const out = await this.guarded(ip, async () => {
      const p = await this.peek(token);
      if (!p) return null;
      const errors = passwordPolicyErrors(
        body.password,
        { email: p.email, employeeId: p.employee_id, phone: p.phone },
        "/password",
      );
      if (errors.length > 0)
        throw new ProblemException(422, "weak_password", {
          detail: "The password does not meet the policy.",
          errors,
        });
      const hash = await this.passwords.hash(body.password);
      const r = await this.db.client.$queryRaw<
        { status: string; two_factor: boolean | null }[]
      >(Prisma.sql`
        SELECT r_status AS status, r_two_factor AS two_factor FROM inv_accept(${p.hash}::text, ${hash}::text)`);
      const row = r[0];
      if (!row || row.status === "invalid") return null;
      if (row.status === "conflict") {
        conflict = true;
        return { created: true as const, two_factor_enrolment_pending: false };
      }
      return {
        created: true as const,
        two_factor_enrolment_pending: row.two_factor === true,
      };
    });
    if (conflict) {
      throw new ProblemException(409, "duplicate", {
        detail:
          "The email, employee ID or phone of this invitation is now used by another account. Ask an administrator.",
      });
    }
    return out;
  }
}
