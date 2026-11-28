-- 0657: the menu key of the Follow-up hub (My Work > Follow-up, proposal item 11). Additive; an existing key is kept.
-- Mirror of this file: apps/api/prisma/migrations/0657_follow_up_nav/migration.sql (kept byte-identical).
--
-- WHY. A saved menu layout is refused for a key the catalogue does not list, so the new screen needs its row. The entry shows to anyone who may use
-- My Work or Approvals (web rule ANY_OF), so no permission is widened; the page reads only data the person may already read.
-- No table, no column, no grant change.

INSERT INTO nav_item_catalogue (key, default_group, ord, added_in) VALUES
  ('follow_up', 'work', 266, '0657')
ON CONFLICT (key) DO NOTHING;
