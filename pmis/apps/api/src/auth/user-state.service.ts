import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DbService } from '../db/db.service';
import type { UserState } from './auth.types';

const TTL_MS = 60_000;

interface StateRow {
  is_admin: boolean;
  has_assignment: boolean;
  must_change: boolean | null;
}

/**
 * Admin membership, assignment presence and the must-change flag, re-read at most every 60 seconds (ADR 0002 section 5).
 * Anything that changes them through this API drops the entry at once.
 */
@Injectable()
export class UserStateService {
  private readonly cache = new Map<string, { at: number; state: Omit<UserState, 'pending'> }>();

  constructor(private readonly db: DbService) {}

  async get(userId: string, email: string, status: string): Promise<UserState> {
    const hit = this.cache.get(userId);
    let base = hit && Date.now() - hit.at < TTL_MS ? hit.state : undefined;
    if (!base) {
      const rows = await this.db.client.$queryRaw<StateRow[]>(Prisma.sql`
        SELECT app_user_is_system_admin(${userId}::uuid) AS is_admin,
               EXISTS (SELECT 1 FROM user_role_assignments a WHERE a.user_id = ${userId}::uuid AND a.valid_from <= now()
                       AND (a.valid_to IS NULL OR a.valid_to > now())) AS has_assignment,
               (SELECT l.must_change FROM auth_local_lookup(${email}) l) AS must_change`);
      const r = rows[0];
      base = { isAdmin: r?.is_admin ?? false, hasAssignment: r?.has_assignment ?? false, mustChange: r?.must_change ?? false };
      this.cache.set(userId, { at: Date.now(), state: base });
    }
    const pending = status === 'pending_assignment' || (status === 'active' && !base.hasAssignment && !base.isAdmin);
    return { ...base, pending };
  }

  invalidate(...userIds: string[]): void {
    for (const id of userIds) this.cache.delete(id);
  }

  invalidateAll(): void {
    this.cache.clear();
  }
}
