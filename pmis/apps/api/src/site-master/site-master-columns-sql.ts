import { Prisma } from '@prisma/client';

/** The Master columns, with the effective kind of source (0.15.35): a not-tracked column takes the kind of a mapping an admin added later. */
export const COLUMNS_SQL = Prisma.sql`
  SELECT mc.ord, mc.letter, mc.group_top, mc.group_mid, mc.header, mc.site_master_sections AS sections,
    CASE
      WHEN mc.source_kind <> 'not_tracked' THEN mc.source_kind
      WHEN EXISTS (SELECT 1 FROM field_definitions fd WHERE fd.entity_type::text = 'site' AND fd.is_active AND fd.master_export_column = mc.letter) THEN 'custom_field'
      WHEN EXISTS (SELECT 1 FROM template_task_fields tf WHERE tf.is_active AND tf.master_col = mc.letter) THEN 'task'
      WHEN EXISTS (SELECT 1 FROM task_field_sources x WHERE x.is_active AND x.master_col = mc.letter) THEN 'register'
      ELSE 'not_tracked'
    END AS source_kind,
    mc.source_note, mc.display_order, mc.name_ar, mc.is_added,
    -- 0133: the effective type and list (a column filled by a task input reads the input)
    coalesce((SELECT tf.field_type FROM template_task_fields tf WHERE tf.is_active AND tf.master_col = mc.letter ORDER BY tf.task_code, tf.field_key LIMIT 1), mc.value_type, 'text') AS value_type,
    CASE WHEN EXISTS (SELECT 1 FROM template_task_fields tf WHERE tf.is_active AND tf.master_col = mc.letter)
         THEN (SELECT tf.list_catalogue FROM template_task_fields tf WHERE tf.is_active AND tf.master_col = mc.letter ORDER BY tf.task_code, tf.field_key LIMIT 1)
         ELSE mc.list_catalogue END AS list_catalogue
  FROM master_columns mc`;
