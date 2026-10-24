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

-- History is never rewritten: a rule used by any task instance keeps its terms; only effective_to (closing it) may change.
CREATE OR REPLACE FUNCTION sla_rules_freeze_used() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.task_def_id, NEW.min_working_days, NEW.max_working_days, NEW.start_event, NEW.scenario, NEW.region_id, NEW.calendar_id, NEW.effective_from)
     IS DISTINCT FROM
     (OLD.task_def_id, OLD.min_working_days, OLD.max_working_days, OLD.start_event, OLD.scenario, OLD.region_id, OLD.calendar_id, OLD.effective_from)
     AND EXISTS (SELECT 1 FROM task_instances WHERE sla_rule_id = OLD.id) THEN
    RAISE EXCEPTION 'sla_rule % is referenced by tasks; create a new version instead', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sla_rules_frozen BEFORE UPDATE ON sla_rules FOR EACH ROW EXECUTE FUNCTION sla_rules_freeze_used();

-- A task keeps the rule it opened with. Re-pointing is the admin path only: the API sets app.allow_sla_repoint = 'on'
-- after step-up MFA and writes an audit row; approved tasks can never be re-pointed. Setting it for the first time
-- (NULL -> rule, when the task opens) is always allowed.
CREATE OR REPLACE FUNCTION task_sla_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sla_rule_id IS NOT NULL AND NEW.sla_rule_id IS DISTINCT FROM OLD.sla_rule_id THEN
    IF coalesce(current_setting('app.allow_sla_repoint', true), '') <> 'on' THEN
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
