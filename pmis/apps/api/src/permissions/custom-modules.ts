import { Prisma } from '@prisma/client';
import type { DbService } from '../db/db.service';
import type { ModuleDef } from './catalogue';

/** The rights a custom register's module offers (the same list as every register: the grid editor shows it like any other module). */
const OPERATIONAL = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'import', 'download_documents', 'view_audit'];

/**
 * Migration 0592: the permission modules of the custom registers. The module key of a custom register is its register key; the module catalogue in code lists the built-in modules,
 * so the custom ones are read from the register definitions. `activeOnly` is for what the grid editor offers; a hidden register keeps its grants, so validation accepts every key.
 */
export async function customModuleDefs(db: DbService, activeOnly: boolean): Promise<ModuleDef[]> {
  const rows = await db.tx.$queryRaw<{ module_key: string; name_en: string }[]>(Prisma.sql`
    SELECT module_key, name_en FROM register_definitions WHERE is_custom ${activeOnly ? Prisma.sql`AND is_active` : Prisma.empty} ORDER BY sort_order, register_key`);
  return rows.map((r) => ({ key: r.module_key, name_en: r.name_en, actions: OPERATIONAL }));
}

export async function customModuleKeys(db: DbService): Promise<Set<string>> {
  return new Set((await customModuleDefs(db, false)).map((m) => m.key));
}
