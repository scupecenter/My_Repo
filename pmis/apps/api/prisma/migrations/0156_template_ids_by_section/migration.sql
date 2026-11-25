-- 0156_template_ids_by_section: template IDs follow the section and register names (owner decision 2026-11-25, GitHub PR #214).
-- Mirror: db/sql/155_template_ids_by_section.sql (kept byte-identical).
--
--   1. The IDs. Every template ID that named a stream, the new-sites template or a register by an abbreviation gets a short readable name
--      (TPL-SITE-CW becomes TPL-CIVIL, TPL-PO becomes TPL-PROCUREMENT, ...). TPL-MASTER, TPL-RF, TPL-HLC, TPL-GECOL, TPL-HOLIDAYS and TPL-LISTVALUES keep
--      their ID. The versions follow by ON UPDATE CASCADE (template_versions.template_def_id is the uuid, nothing else changes).
--   2. The old IDs. template_definitions.previous_ids keeps the IDs a template had before. A file downloaded earlier still carries the old ID in its
--      hidden _tpl sheet: the upload refuses it as an outdated version and names the new template (import.service, reason outdated_version).
--   3. History. import_uploads.template_id (text, no foreign key) is moved to the new ID, so the lists show the new name. The audit and System Log rows are
--      a record of what was said at the time and are not rewritten: they keep the old ID in their text.
--   4. Stored functions that name a template by its literal ID are rewritten with the new ID: the Master create-sites function of 0155
--      (master_create_sites) looked up 'TPL-SITE-NEW'. The migration finds every public function whose body holds an old ID and replaces
--      it (CREATE OR REPLACE keeps the owner and the grants). The other stored functions find a template by kind, stream_code or register_key.

ALTER TABLE template_definitions ADD COLUMN previous_ids text[] NOT NULL DEFAULT '{}';

CREATE TEMP TABLE _tpl_rename (old_id text PRIMARY KEY, new_id text NOT NULL UNIQUE) ON COMMIT DROP;
INSERT INTO _tpl_rename (old_id, new_id) VALUES
  ('TPL-SITE-DA',  'TPL-DESIGN-ACQ'),
  ('TPL-SITE-CW',  'TPL-CIVIL'),
  ('TPL-SITE-TE',  'TPL-INSTALL'),
  ('TPL-SITE-CL',  'TPL-CLOSURE'),
  ('TPL-SITE-NEW', 'TPL-NEW-SITES'),
  ('TPL-PO',       'TPL-PROCUREMENT'),
  ('TPL-CTR',      'TPL-CONTRACTORS'),
  ('TPL-ACQ',      'TPL-ACQUISITION'),
  ('TPL-PRM',      'TPL-PERMITS'),
  ('TPL-WH',       'TPL-WAREHOUSE'),
  ('TPL-QLT',      'TPL-QUALITY'),
  ('TPL-ISS',      'TPL-ISSUES'),
  ('TPL-RSK',      'TPL-RISKS'),
  ('TPL-CHG',      'TPL-CHANGES'),
  ('TPL-RDY',      'TPL-READINESS'),
  ('TPL-ASB',      'TPL-AS-BUILT'),
  ('TPL-MTG',      'TPL-MEETINGS'),
  ('TPL-DIS',      'TPL-DISMANTLE'),
  ('TPL-CAR',      'TPL-FLEET'),
  ('TPL-ADV',      'TPL-ADVANCES');

UPDATE template_definitions d
   SET previous_ids = d.previous_ids || r.old_id, template_id = r.new_id
  FROM _tpl_rename r
 WHERE d.template_id = r.old_id;

UPDATE import_uploads j SET template_id = r.new_id FROM _tpl_rename r WHERE j.template_id = r.old_id;

-- 4. functions that hold an old ID as a literal (the 0155 Master create-sites function holds TPL-SITE-NEW)
DO $$
DECLARE r record; m record; src text;
BEGIN
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.prokind = 'f'
              AND EXISTS (SELECT 1 FROM template_definitions d, unnest(d.previous_ids) o WHERE position('''' || o || '''' IN p.prosrc) > 0)
  LOOP
    src := pg_get_functiondef(r.oid);
    FOR m IN SELECT o AS old_id, d.template_id AS new_id FROM template_definitions d, unnest(d.previous_ids) o LOOP
      src := replace(src, '''' || m.old_id || '''', '''' || m.new_id || '''');
    END LOOP;
    EXECUTE src;
  END LOOP;
END $$;
