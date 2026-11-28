import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { AuthContext } from "../auth/auth.types";
import { StepUpService } from "../auth/step-up.service";
import { mapDbError } from "../common/db-errors";
import { ProblemException } from "../common/problem";
import { parse, uuidSchema } from "../common/zod";
import { DbService } from "../db/db.service";

/** Migration 0565: the lock kinds. The Warehouse kinds are used from 0565, the Daily Plan kinds from 0566. */
export const LOCK_KINDS = ["wh_item", "wh_movement", "daily_plan", "daily_plan_row"] as const;
export const COLUMN_LOCK_KINDS = ["wh_item", "wh_movement", "daily_plan_row"] as const;
const reasonSchema = z.object({ reason: z.string().trim().min(3).max(2000) }).passthrough();
const kindSchema = z.enum(LOCK_KINDS);
const columnKindSchema = z.enum(COLUMN_LOCK_KINDS);
const fieldSchema = z.string().trim().min(1).max(64);

/**
 * Locks of the Warehouse and the Daily Plan, on the model of the register locks (0103): the same administer right, reason, audit and step-up.
 * The database decides (ent_lock_set / ent_column_lock_set); a locked target or column answers 403 register_locked from the writers.
 */
@Injectable()
export class EntityLocksService {
  constructor(
    private readonly db: DbService,
    private readonly stepUp: StepUpService,
  ) {}

  private async run(sql: Prisma.Sql): Promise<void> {
    await this.db.tx.$executeRaw`SAVEPOINT ent_lock`;
    try {
      await this.db.tx.$queryRaw(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT ent_lock`;
    } catch (e) {
      if (e instanceof ProblemException) throw e;
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT ent_lock`;
      throw p;
    }
  }

  /** Open locks (record and column), optionally of one kind. A lock whose target no longer exists is not listed. */
  async list(kindRaw: unknown): Promise<{ records: unknown[]; columns: unknown[] }> {
    const kind = kindRaw === undefined || kindRaw === "" ? null : parse(kindSchema, kindRaw);
    const r = await this.db.tx.$queryRaw<{ j: { records: unknown[]; columns: unknown[] } }[]>(Prisma.sql`SELECT ent_lock_list(${kind}::text) AS j`);
    return r[0]!.j;
  }

  async setLock(auth: AuthContext, kindRaw: string, idRaw: string, rawBody: unknown, locked: boolean): Promise<{ kind: string; id: string; locked: boolean }> {
    const kind = parse(kindSchema, kindRaw);
    const id = parse(uuidSchema, idRaw);
    const body = parse(reasonSchema, rawBody ?? {});
    await this.stepUp.require(auth);
    await this.run(Prisma.sql`SELECT true AS r FROM (SELECT ent_lock_set(${kind}::text, ${id}::uuid, ${locked}::boolean, ${body.reason}::text)) v`);
    return { kind, id, locked };
  }

  async setColumnLock(auth: AuthContext, kindRaw: string, fieldRaw: string, rawBody: unknown, locked: boolean): Promise<{ kind: string; field: string; locked: boolean }> {
    const kind = parse(columnKindSchema, kindRaw);
    const field = parse(fieldSchema, fieldRaw);
    const body = parse(reasonSchema, rawBody ?? {});
    await this.stepUp.require(auth);
    await this.run(Prisma.sql`SELECT true AS r FROM (SELECT ent_column_lock_set(${kind}::text, ${field}::text, ${locked}::boolean, ${body.reason}::text)) v`);
    return { kind, field, locked };
  }
}
