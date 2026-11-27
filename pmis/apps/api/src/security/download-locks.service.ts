import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { parseIfMatch } from '../common/etag';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

const putBody = z.object({
  templates: z.boolean(),
  uploaded_files: z.boolean(),
  generated_documents: z.boolean(),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export interface DownloadLocksDto {
  templates: boolean;
  uploaded_files: boolean;
  generated_documents: boolean;
  updated_at: string | null;
  updated_by: { id: string; display_name: string; employee_id: string | null } | null;
  version: number;
  can_edit: boolean;
}

/**
 * Download lock categories (migration 0293, setting security.download_locks): blank templates, one uploaded file, one generated library document. All off until a System
 * Admin turns one on. Everyone reads the state (the UI disables what is locked); only a System Admin changes it, with a reason, a step-up and If-Match, and the database
 * audits it (download_locks_update). The routes are enforced by `@ExportAction({ category })`.
 */
@Injectable()
export class DownloadLocksService {
  constructor(private readonly db: DbService, private readonly stepUp: StepUpService) {}

  private async one(sql: Prisma.Sql): Promise<DownloadLocksDto> {
    const rows = await this.db.tx.$queryRaw<{ r: DownloadLocksDto }[]>(sql);
    return rows[0]!.r;
  }

  get(): Promise<DownloadLocksDto> {
    return this.one(Prisma.sql`SELECT download_locks_state() AS r`);
  }

  async set(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<DownloadLocksDto> {
    const b = parse(putBody, raw);
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return this.one(Prisma.sql`SELECT admin_set_download_locks(${b.templates}::boolean, ${b.uploaded_files}::boolean, ${b.generated_documents}::boolean, ${b.reason}::text, ${etag}::int) AS r`);
  }
}
