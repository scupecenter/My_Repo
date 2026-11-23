import { Prisma } from '@prisma/client';
import { ProblemException } from '../common/problem';
import type { DbService } from '../db/db.service';

/**
 * Dependent lists on save (0.15.51), called right after the entry is written in the same transaction, so a refusal rolls the save back. A list field whose catalogue has a parent catalogue (`list_catalogues.parent_catalogue`, and `list_values.parent_value_id`
 * on each value) only accepts a value whose parent value equals the parent value held by the same site: the list field of the parent catalogue, in this task
 * or in another task of the site. While the parent value is empty the child is accepted (as the screens do); a value that is not in the catalogue, or has no
 * parent, is not checked here (the rule of the save for those is unchanged). Clearing a value (null or empty) is never refused by this rule.
 */
export async function assertListParents(db: Pick<DbService, 'tx'>, taskId: string, values: Record<string, unknown> | undefined): Promise<void> {
  const given = Object.entries(values ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '');
  if (given.length === 0) return;
  const keys = given.map(([k]) => `v:${k}`);
  // the list fields of this task that are written and whose catalogue depends on a parent catalogue
  const children = await db.tx.$queryRaw<{ field_key: string; list_catalogue: string; parent_catalogue: string; site_id: string; workflow_id: string }[]>(Prisma.sql`
    SELECT tf.field_key, tf.list_catalogue, c.parent_catalogue, ti.site_id::text AS site_id, s.workflow_version_id::text AS workflow_id
    FROM task_instances ti
    JOIN sites s ON s.id = ti.site_id
    JOIN task_definitions td ON td.id = ti.task_def_id
    JOIN template_task_fields tf ON tf.task_code = td.code AND tf.is_active AND tf.field_type = 'list' AND tf.field_key = ANY(${keys}::text[])
      AND (tf.scenarios IS NULL OR s.delivery_scenario::text = ANY (tf.scenarios))
    JOIN list_catalogues c ON c.code = tf.list_catalogue AND c.parent_catalogue IS NOT NULL
    WHERE ti.id = ${taskId}::uuid`);
  for (const child of children) {
    const key = child.field_key.slice(2);
    const value = (values as Record<string, string>)[key]!.trim();
    const own = await db.tx.$queryRaw<{ parent_code: string | null }[]>(Prisma.sql`
      SELECT p.code AS parent_code FROM list_values v LEFT JOIN list_values p ON p.id = v.parent_value_id
      WHERE v.catalogue_code = ${child.list_catalogue} AND v.code = ${value} AND v.is_active`);
    const wanted = own[0]?.parent_code;
    if (!wanted) continue;
    // the parent values the site holds (this request is already written, so a parent saved in the same call counts)
    const held = await db.tx.$queryRaw<{ val: string | null }[]>(Prisma.sql`
      SELECT ti.values ->> substr(tf.field_key, 3) AS val
      FROM task_instances ti
      JOIN sites s ON s.id = ti.site_id
      JOIN task_definitions td ON td.id = ti.task_def_id AND td.workflow_id = s.workflow_version_id
      JOIN template_task_fields tf ON tf.task_code = td.code AND tf.is_active AND tf.field_type = 'list' AND tf.list_catalogue = ${child.parent_catalogue}
        AND tf.field_key LIKE 'v:%' AND (tf.scenarios IS NULL OR s.delivery_scenario::text = ANY (tf.scenarios))
      WHERE ti.site_id = ${child.site_id}::uuid`);
    const parents = held.map((h) => (h.val ?? '').trim()).filter((v) => v !== '');
    if (parents.length === 0 || parents.includes(wanted)) continue;
    throw new ProblemException(422, 'list_parent_mismatch', {
      detail: `The value "${value}" belongs to the parent value "${wanted}", but the parent value of this site is "${parents.join('", "')}".`,
      errors: [{ path: `/values/${key}`, code: 'list_parent_mismatch', message: `Choose a value of the parent "${parents[0]}".` }],
      extra: { field: key, list: child.list_catalogue, parent_list: child.parent_catalogue, expected_parent: parents },
    });
  }
}
