import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { mapDbError } from "../common/db-errors";
import { parse } from "../common/zod";
import { DbService } from "../db/db.service";
import {
  layoutSaveSchema,
  tabSchema,
  templateSaveSchema,
} from "./dashboard-user-widgets.schema";

export interface UserLayout {
  order: string[];
  hidden: string[];
  version: number;
}
export interface UserTemplate {
  id: string;
  name: string;
  layouts: Record<string, { order: string[]; hidden: string[] }>;
  created_at: string;
}

/**
 * Per-user dashboard widgets (contract 0.15.585, migration 0713). The caller arranges and hides the cards of their own dashboard tabs and keeps named
 * templates. Personal display preference: reads and writes need dashboard.view only and touch the caller's own rows (row level security), so no grant,
 * role or permission changes; the data of every card is still filtered by the caller's own rights. A tab without a personal layout follows the global
 * layout of Settings > Dashboard (F20, 0.15.24).
 */
@Injectable()
export class DashboardUserWidgetsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  private async run<T>(sql: Prisma.Sql): Promise<T> {
    try {
      const rows = await this.db.tx.$queryRaw<{ r: T }[]>(sql);
      return rows[0]?.r as T;
    } catch (e) {
      const p = mapDbError(e);
      if (p) throw p;
      throw e;
    }
  }

  /** GET /me/dashboard-layout: the tabs the caller customised. */
  async layouts(auth: AuthContext) {
    await this.access.requireModuleView(auth, "dashboard");
    return {
      tabs: await this.run<Record<string, UserLayout>>(
        Prisma.sql`SELECT dash_my_layouts() AS r`,
      ),
    };
  }

  /** PUT /me/dashboard-layout/{tab} */
  async save(auth: AuthContext, tab: string, raw: unknown) {
    await this.access.requireModuleView(auth, "dashboard");
    const t = parse(tabSchema, tab);
    const b = parse(layoutSaveSchema, raw);
    return this.run<UserLayout & { tab: string }>(
      Prisma.sql`SELECT dash_my_layout_save(${t}::text, ${b.order}::text[], ${b.hidden}::text[], ${b.version}::int) AS r`,
    );
  }

  /** DELETE /me/dashboard-layout/{tab}: back to the global layout. */
  async reset(auth: AuthContext, tab: string) {
    await this.access.requireModuleView(auth, "dashboard");
    const t = parse(tabSchema, tab);
    return this.run<{ tab: string; reset: boolean }>(
      Prisma.sql`SELECT dash_my_layout_reset(${t}::text) AS r`,
    );
  }

  /** GET /me/dashboard-templates */
  async templates(auth: AuthContext) {
    await this.access.requireModuleView(auth, "dashboard");
    return {
      items: await this.run<UserTemplate[]>(
        Prisma.sql`SELECT dash_my_templates() AS r`,
      ),
    };
  }

  /** POST /me/dashboard-templates (a name already used by the caller is replaced) */
  async saveTemplate(auth: AuthContext, raw: unknown) {
    await this.access.requireModuleView(auth, "dashboard");
    const b = parse(templateSaveSchema, raw);
    return this.run<Omit<UserTemplate, "created_at">>(
      Prisma.sql`SELECT dash_my_template_save(${b.name}::text, ${JSON.stringify(b.layouts)}::jsonb) AS r`,
    );
  }

  /** POST /me/dashboard-templates/{id}/apply */
  async applyTemplate(auth: AuthContext, id: string) {
    await this.access.requireModuleView(auth, "dashboard");
    const r = await this.run<Record<string, UserLayout>>(
      Prisma.sql`SELECT dash_my_template_apply(${id}::uuid) AS r`,
    );
    return { tabs: r };
  }

  /** DELETE /me/dashboard-templates/{id} */
  async deleteTemplate(auth: AuthContext, id: string) {
    await this.access.requireModuleView(auth, "dashboard");
    return this.run<{ id: string; deleted: boolean }>(
      Prisma.sql`SELECT dash_my_template_delete(${id}::uuid) AS r`,
    );
  }
}
