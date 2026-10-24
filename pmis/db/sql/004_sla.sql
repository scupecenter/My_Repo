-- 004: SLA rules and work calendar integrity. Applied after 0001 (tables come from Prisma).

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE sla_rules ADD CONSTRAINT sla_rules_min_max CHECK (min_working_days >= 0 AND max_working_days >= 0 AND min_working_days <= max_working_days);
ALTER TABLE sla_rules ADD CONSTRAINT sla_rules_range  CHECK (effective_to IS NULL OR effective_to > effective_from);

CREATE OR REPLACE FUNCTION sla_scope_key(s "DeliveryScenario") RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce(s::text, '') $$;

-- No two rules overlap for the same task and scope (scenario / region; NULL = all, compared as its own scope).
ALTER TABLE sla_rules ADD CONSTRAINT sla_rules_no_overlap EXCLUDE USING gist (
  task_def_id WITH =,
  sla_scope_key(scenario) WITH =,
  (coalesce(region_id, 0)) WITH =,
  daterange(effective_from, effective_to, '[)') WITH &&
);

-- Weekend days must be 0..6, at least one working day; exactly one default calendar.
ALTER TABLE work_calendars ADD CONSTRAINT work_calendars_weekend CHECK (weekend_days <@ ARRAY[0,1,2,3,4,5,6] AND cardinality(weekend_days) BETWEEN 0 AND 6);
CREATE UNIQUE INDEX work_calendars_one_default ON work_calendars ((true)) WHERE is_default;

-- "Is this rule used by any task?" must see tasks of EVERY region, so it runs as pmis_definer (BYPASSRLS), not as the caller.
-- It first locks the rule row FOR UPDATE: this waits for any concurrent task assignment (which holds FOR SHARE, below) to
-- commit, and the VOLATILE EXISTS that follows then takes a fresh snapshot that sees that task.
CREATE OR REPLACE FUNCTION sla_rule_in_use(p_rule uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM 1 FROM public.sla_rules WHERE id = p_rule FOR UPDATE;
  RETURN EXISTS (SELECT 1 FROM public.task_instances WHERE sla_rule_id = p_rule);
END $$;

-- Taking a share lock on the rule when a task is assigned to it (definer: the caller may lack UPDATE on sla_rules).
CREATE OR REPLACE FUNCTION sla_rule_lock_share(p_rule uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM 1 FROM public.sla_rules WHERE id = p_rule FOR SHARE;
END $$;

ALTER FUNCTION sla_rule_in_use(uuid) OWNER TO pmis_definer;
ALTER FUNCTION sla_rule_lock_share(uuid) OWNER TO pmis_definer;
GRANT SELECT, UPDATE ON sla_rules TO pmis_definer;
GRANT SELECT ON task_instances TO pmis_definer;
REVOKE ALL ON FUNCTION sla_rule_in_use(uuid), sla_rule_lock_share(uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION sla_rule_in_use(uuid), sla_rule_lock_share(uuid) TO pmis_app;
  END IF;
END $$;

-- History is never rewritten: a rule used by any task instance keeps its terms; only effective_to (closing it) may change.
CREATE OR REPLACE FUNCTION sla_rules_freeze_used() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.task_def_id, NEW.min_working_days, NEW.max_working_days, NEW.start_event, NEW.scenario, NEW.region_id, NEW.calendar_id, NEW.effective_from)
     IS DISTINCT FROM
     (OLD.task_def_id, OLD.min_working_days, OLD.max_working_days, OLD.start_event, OLD.scenario, OLD.region_id, OLD.calendar_id, OLD.effective_from)
     AND sla_rule_in_use(OLD.id) THEN
    RAISE EXCEPTION 'sla_rule % is referenced by tasks; create a new version instead', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sla_rules_frozen BEFORE UPDATE ON sla_rules FOR EACH ROW EXECUTE FUNCTION sla_rules_freeze_used();

-- Assigning a task to a rule takes a share lock on the rule row, so a concurrent edit of that rule cannot slip in between.
CREATE OR REPLACE FUNCTION task_sla_lock_rule() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sla_rule_id IS NOT NULL THEN PERFORM sla_rule_lock_share(NEW.sla_rule_id); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_sla_lock BEFORE INSERT OR UPDATE OF sla_rule_id ON task_instances FOR EACH ROW EXECUTE FUNCTION task_sla_lock_rule();

-- A task keeps the rule it opened with. Re-pointing is possible only inside admin_repoint_sla() (SECURITY DEFINER, owner
-- pmis_definer) or as the migration role; no session setting can open this path. Approved tasks can never be re-pointed. Setting it for the first time
-- (NULL -> rule, when the task opens) is always allowed.
CREATE OR REPLACE FUNCTION task_sla_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sla_rule_id IS NOT NULL AND NEW.sla_rule_id IS DISTINCT FROM OLD.sla_rule_id THEN
    IF NOT app_in_admin_path() THEN
      RAISE EXCEPTION 'task_instances.sla_rule_id is a snapshot; use the admin re-point path' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.state = 'approved' THEN
      RAISE EXCEPTION 'approved tasks keep their SLA rule' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_sla_snapshot BEFORE UPDATE OF sla_rule_id ON task_instances FOR EACH ROW EXECUTE FUNCTION task_sla_snapshot_guard();

-- Rule in force for a task on a date: most specific scope wins (scenario+region > region > scenario > all).
CREATE OR REPLACE FUNCTION sla_rule_for(p_task_def uuid, p_scenario "DeliveryScenario", p_region integer, p_on date) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT id FROM sla_rules
  WHERE task_def_id = p_task_def
    AND (scenario IS NULL OR scenario = p_scenario)
    AND (region_id IS NULL OR region_id = p_region)
    AND effective_from <= p_on AND (effective_to IS NULL OR effective_to > p_on)
  ORDER BY (region_id IS NOT NULL)::int * 2 + (scenario IS NOT NULL)::int DESC
  LIMIT 1
$$;

-- Admin re-point: moves OPEN (not approved) tasks from one rule to another version of the same task definition.
-- Full-access session only, reason required, audited.
CREATE OR REPLACE FUNCTION admin_repoint_sla(p_old uuid, p_new uuid, p_reason text) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer; nt uuid;
BEGIN
  IF NOT public.app_is_full_access() THEN
    RAISE EXCEPTION 'admin path: full-access session required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'a reason is required'; END IF;
  SELECT task_def_id INTO nt FROM public.sla_rules WHERE id = p_new;
  IF nt IS NULL OR nt IS DISTINCT FROM (SELECT task_def_id FROM public.sla_rules WHERE id = p_old) THEN
    RAISE EXCEPTION 'both rules must exist and belong to the same task definition';
  END IF;
  WITH u AS (
    UPDATE public.task_instances SET sla_rule_id = p_new, updated_at = now()
    WHERE sla_rule_id = p_old AND state <> 'approved' RETURNING 1)
  SELECT count(*) INTO n FROM u;
  INSERT INTO public.audit_log (action, entity_type, entity_id, reason, before, after, is_admin_override, actor_id)
  VALUES ('sla_repoint', 'sla_rule', p_new::text, p_reason, jsonb_build_object('rule', p_old), jsonb_build_object('rule', p_new, 'tasks', n), true,
          nullif(current_setting('app.user_id', true), '')::uuid);
  RETURN n;
END $$;
ALTER FUNCTION admin_repoint_sla(uuid, uuid, text) OWNER TO pmis_definer;
GRANT UPDATE ON task_instances TO pmis_definer;
GRANT INSERT ON audit_log TO pmis_definer;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO pmis_definer;
REVOKE ALL ON FUNCTION admin_repoint_sla(uuid, uuid, text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION admin_repoint_sla(uuid, uuid, text) TO pmis_app;
  END IF;
END $$;
