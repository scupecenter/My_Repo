-- 005: weight sets. Applied after 0001.
-- Choice for the 100% rule: a DEFERRED CONSTRAINT TRIGGER in the database (not an API-only check), so no code path can
-- publish a set whose weights do not add up. It fires at commit for sets with status = 'published'.
-- Tolerance 0.001 (weights are stored with 3 decimals).

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE weight_sets ADD CONSTRAINT weight_sets_range CHECK (effective_to IS NULL OR effective_to > effective_from);
ALTER TABLE weight_sets ADD CONSTRAINT weight_sets_published_at CHECK (status <> 'published' OR published_at IS NOT NULL);
ALTER TABLE weight_activities ADD CONSTRAINT weight_activities_range CHECK (weight >= 0 AND weight <= 100);
ALTER TABLE weight_items      ADD CONSTRAINT weight_items_range      CHECK (weight >= 0 AND weight <= 100);

-- Published sets of one code never overlap in time.
ALTER TABLE weight_sets ADD CONSTRAINT weight_sets_no_overlap EXCLUDE USING gist (
  code WITH =, daterange(effective_from, effective_to, '[)') WITH &&
) WHERE (status = 'published');

-- One snapshot per date, set and scope.
CREATE UNIQUE INDEX progress_snapshots_scope_key ON progress_snapshots (snapshot_date, weight_set_id, coalesce(region_id, 0), is_global);

-- 100% rule, per level, for published sets: activities of the set, then items of each activity that has items.
CREATE OR REPLACE FUNCTION weight_set_check(p_set uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE st weight_sets%ROWTYPE; total numeric; r record;
BEGIN
  SELECT * INTO st FROM weight_sets WHERE id = p_set;
  IF NOT FOUND OR st.status <> 'published' THEN RETURN; END IF;
  SELECT coalesce(sum(weight), 0) INTO total FROM weight_activities WHERE weight_set_id = p_set;
  IF abs(total - 100) > 0.001 THEN
    RAISE EXCEPTION 'weight set % (%) v%: activity weights total %, must be 100', p_set, st.code, st.version, total USING ERRCODE = 'check_violation';
  END IF;
  FOR r IN SELECT a.id, a.code, sum(i.weight) AS s FROM weight_activities a JOIN weight_items i ON i.activity_id = a.id
           WHERE a.weight_set_id = p_set GROUP BY a.id, a.code HAVING abs(sum(i.weight) - 100) > 0.001 LOOP
    RAISE EXCEPTION 'weight set %: items of activity % total %, must be 100', p_set, r.code, r.s USING ERRCODE = 'check_violation';
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION weight_check_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE sid uuid;
BEGIN
  IF TG_TABLE_NAME = 'weight_sets' THEN sid := NEW.id;
  ELSIF TG_TABLE_NAME = 'weight_activities' THEN sid := coalesce(NEW.weight_set_id, OLD.weight_set_id);
  ELSE SELECT a.weight_set_id INTO sid FROM weight_activities a WHERE a.id = coalesce(NEW.activity_id, OLD.activity_id);
  END IF;
  IF sid IS NOT NULL THEN PERFORM weight_set_check(sid); END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER weight_sets_100 AFTER INSERT OR UPDATE ON weight_sets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION weight_check_trigger();
CREATE CONSTRAINT TRIGGER weight_activities_100 AFTER INSERT OR UPDATE OR DELETE ON weight_activities
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION weight_check_trigger();
CREATE CONSTRAINT TRIGGER weight_items_100 AFTER INSERT OR UPDATE OR DELETE ON weight_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION weight_check_trigger();

-- A published set is frozen: structure and weights never change (publish a new version instead). Only effective_to may be
-- set, to close a set. A draft can be edited freely; publishing flips status in one transaction with the 100% check above.
CREATE OR REPLACE FUNCTION weight_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE sid uuid;
BEGIN
  IF TG_TABLE_NAME = 'weight_sets' THEN
    IF OLD.status = 'published' AND (NEW.code, NEW.version, NEW.effective_from, NEW.status, NEW.reason)
       IS DISTINCT FROM (OLD.code, OLD.version, OLD.effective_from, OLD.status, OLD.reason) THEN
      RAISE EXCEPTION 'published weight set % is immutable; create a new version', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' AND OLD.status = 'published' THEN
      RAISE EXCEPTION 'published weight set % cannot be deleted', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_TABLE_NAME = 'weight_activities' THEN sid := coalesce(NEW.weight_set_id, OLD.weight_set_id);
  ELSE SELECT a.weight_set_id INTO sid FROM weight_activities a WHERE a.id = coalesce(NEW.activity_id, OLD.activity_id);
  END IF;
  IF EXISTS (SELECT 1 FROM weight_sets WHERE id = sid AND status = 'published') THEN
    RAISE EXCEPTION 'weight set % is published; its activities and items are immutable', sid USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER weight_sets_frozen   BEFORE UPDATE OR DELETE ON weight_sets       FOR EACH ROW EXECUTE FUNCTION weight_freeze();
CREATE TRIGGER weight_activities_frozen BEFORE INSERT OR UPDATE OR DELETE ON weight_activities FOR EACH ROW EXECUTE FUNCTION weight_freeze();
CREATE TRIGGER weight_items_frozen  BEFORE INSERT OR UPDATE OR DELETE ON weight_items      FOR EACH ROW EXECUTE FUNCTION weight_freeze();
