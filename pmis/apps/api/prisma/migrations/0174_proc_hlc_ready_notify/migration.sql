-- 0174_proc_hlc_ready_notify: package B2 of the contractor and Procurement flow (owner decision 2026-11-26, relayed by Main: when a Procurement record is approved,
-- the site continues in the HLC register and the people who enter its execution data are told).
--
-- 1. When a Procurement record of scope HLC is approved (state changes to approved, the site is known), the entry holders of the HLC register row in the
--    site's region get an in-app notification "Procurement approved: HLC execution data can be entered", linked to the Procurement record. The holders come
--    from the Matrix (reg_entry_holders('hlc', region)): no new permission, no role or grant change, nothing hard-coded.
-- 2. It reuses the existing notification kind register_assigned (so the user's notification preferences and the notification policy apply as for every
--    register notification). No new kind, no contract change.
-- 3. Nothing is sent when: the site already has a current HLC record (nothing waits), the record is a historical direct approval, the load is seeding, or the
--    holder is the person who approved it.
-- Additive: one function and one trigger. No table, so no data_reset_plan change. GECOL has no Procurement scope (Q56): its flow is a separate decision.
CREATE OR REPLACE FUNCTION proc_hlc_ready_notify() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE h record; actor uuid := public.app_actor();
BEGIN
  IF public.app_is_seeding() OR NEW.historical_direct_approved THEN RETURN NULL; END IF;
  IF NEW.site_id IS NULL OR NEW.data ->> 'scope' IS DISTINCT FROM 'HLC' THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.register_records x WHERE x.register_key = 'hlc' AND x.site_id = NEW.site_id AND x.is_current AND x.state <> 'voided') THEN RETURN NULL; END IF;
  FOR h IN SELECT e.user_id FROM public.reg_entry_holders('hlc', NEW.region_id) e LOOP
    IF actor IS NULL OR h.user_id <> actor THEN
      PERFORM public.reg_notify(h.user_id, 'register_assigned', 'Procurement approved: HLC execution data can be entered', public.reg_label(NEW.id), NEW.id);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

DO $$
BEGIN
  EXECUTE 'ALTER FUNCTION proc_hlc_ready_notify() OWNER TO pmis_definer';
  EXECUTE 'REVOKE ALL ON FUNCTION proc_hlc_ready_notify() FROM PUBLIC';
END $$;

DROP TRIGGER IF EXISTS z_proc_hlc_ready_notify ON register_records;
CREATE TRIGGER z_proc_hlc_ready_notify AFTER UPDATE OF state ON register_records FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state = 'approved' AND NEW.register_key = 'procurement') EXECUTE FUNCTION proc_hlc_ready_notify();

INSERT INTO audit_log (action, entity_type, entity_id, after, reason)
VALUES ('proc_hlc_ready_notify_applied', 'register_definitions', NULL,
        jsonb_build_object('decision', 'owner 2026-11-26: an approved Procurement record sends the site on; the HLC entry holders are notified'),
        'Migration 0174: notification of the HLC entry holders when a scope-HLC Procurement record is approved.');
