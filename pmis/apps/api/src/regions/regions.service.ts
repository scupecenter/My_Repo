import { Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth/auth.types';
import { DbService } from '../db/db.service';

export interface RegionDto {
  id: number;
  code: string;
  name_en: string;
  name_ar: string | null;
  visible: boolean;
}

/** The contract's region codes by id (RegionId: 1 Tripoli, 2 Middle, 3 WM, 4 Zawia, 5 Benghazi, 6 GM, 7 Sebha). */
export const REGION_CODES: Record<number, string> = { 1: 'Tripoli', 2: 'Middle', 3: 'WM', 4: 'Zawia', 5: 'Benghazi', 6: 'GM', 7: 'Sebha' };

@Injectable()
export class RegionsService {
  constructor(private readonly db: DbService) {}

  /**
   * GET /regions. `visible` = the caller can see sites of the region in at least one module: every region for a System Admin,
   * otherwise the union of the regions of the active assignments (app_resolve_region_ids, ADR 0003).
   */
  async list(auth: AuthContext): Promise<{ items: RegionDto[] }> {
    const rows = await this.db.tx.region.findMany({ orderBy: { id: 'asc' } });
    let all = auth.state.isAdmin;
    const ids = new Set<number>();
    if (!all) {
      const r = await this.db.tx.$queryRaw<{ v: string }[]>`SELECT app_resolve_region_ids(${auth.user.id}::uuid) AS v`;
      const v = r[0]?.v ?? '';
      if (v === '*') all = true;
      else v.split(',').filter((x) => x !== '').forEach((x) => ids.add(Number(x)));
    }
    return {
      items: rows.map((r) => ({
        id: r.id,
        code: REGION_CODES[r.id] ?? r.code,
        name_en: r.name_en,
        name_ar: r.name_ar,
        visible: all || ids.has(r.id),
      })),
    };
  }
}
