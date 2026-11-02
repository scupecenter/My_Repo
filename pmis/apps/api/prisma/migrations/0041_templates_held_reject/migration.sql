-- 0041_templates_held_reject: returning a held import row needs the same authority as returning a record (security review of 0037).
-- Mirror: db/sql/040_templates_held_reject.sql (kept identical to prisma/migrations/0041_templates_held_reject/migration.sql).
--
-- imp_decide_batch let anyone who reached the batch return a row that is held (`pending_previous_approval`, no register record yet).
-- Now only the uploader (taking the row back) or an L2 holder of the register row in the row's region may return it; anyone else gets
-- `not_eligible_holder` for that row (403 when no row was decided). CREATE OR REPLACE keeps the owner (pmis_definer) and the grants of 0037.

CREATE OR REPLACE FUNCTION imp_decide_batch(p_batch uuid, p_version int, p_action text, p_scope text, p_rows jsonb, p_note text, p_stepup boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor uuid := public.app_actor(); b public.import_batches%ROWTYPE; r public.v_import_rows%ROWTYPE; want jsonb; ids uuid[]; act text; rnote text; decided int := 0; approved int := 0; rejected int := 0;
  held jsonb := '[]'::jsonb; failed jsonb := '[]'::jsonb; j jsonb; first_forbidden text; st text; new_st text; msg text; rec public.register_records%ROWTYPE; item jsonb; uploader uuid;
BEGIN
  b := public.imp_lock_batch(p_batch, p_version);
  IF p_action NOT IN ('review', 'approve', 'reject', 'discard') OR p_scope NOT IN ('all', 'rows') THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/action', 'code', 'invalid', 'message', 'Unknown action or scope.'))));
  END IF;

  IF p_action = 'discard' THEN
    IF b.uploaded_by <> actor AND NOT public.app_user_is_system_admin(actor) THEN
      PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the person who uploaded the file can discard it.'));
    END IF;
    IF b.status <> 'validated' THEN
      PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', 'Only a batch that has not been sent can be discarded. Return the rows with a note instead.'));
    END IF;
    UPDATE public.import_batch_rows SET decision = 'rejected', decided_by = actor, decided_at = now(), decision_note = coalesce(nullif(btrim(p_note), ''), 'discarded') WHERE batch_id = p_batch;
    UPDATE public.import_batches SET status = 'discarded', note = nullif(btrim(p_note), ''), closed_at = now(), version = version + 1 WHERE id = p_batch;
    INSERT INTO public.audit_log (action, entity_type, entity_id, after, reason, actor_id) VALUES ('import_batch_discard', 'import_batch', p_batch::text, jsonb_build_object('status', 'discarded'), p_note, actor);
    RETURN jsonb_build_object('decided', 0, 'approved', 0, 'rejected', 0, 'held', held, 'failed', failed);
  END IF;

  IF b.status NOT IN ('in_approval', 'partially_approved') THEN
    PERFORM public.wf_err('invalid_transition', jsonb_build_object('detail', CASE WHEN b.status = 'validated' THEN 'The batch has not been sent into the flow yet.' ELSE 'The batch is ' || b.status || '.' END));
  END IF;
  IF p_action = 'reject' AND coalesce(btrim(p_note), '') = '' AND p_scope = 'all' THEN PERFORM public.wf_err('note_required'); END IF;
  IF p_scope = 'rows' AND (p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0) THEN
    PERFORM public.wf_err('validation_failed', jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('path', '/rows', 'code', 'required', 'message', 'Name the rows to decide.'))));
  END IF;

  FOR r IN SELECT x.* FROM public.v_import_rows x
           WHERE x.batch_id = p_batch AND x.action IN ('create', 'update') AND (x.region_id IS NULL OR public.app_region_check(x.region_id))
             AND ((p_scope = 'all' AND x.eff_decision IN ('pending', 'pending_previous_approval'))
                  OR (p_scope = 'rows' AND x.id IN (SELECT (e ->> 'row_id')::uuid FROM jsonb_array_elements(p_rows) e)))
           ORDER BY x.row_no LOOP
    item := CASE WHEN p_scope = 'rows' THEN (SELECT e FROM jsonb_array_elements(p_rows) e WHERE (e ->> 'row_id')::uuid = r.id LIMIT 1) END;
    act := CASE WHEN p_action = 'reject' THEN 'reject' WHEN p_scope = 'rows' AND item ->> 'decision' = 'rejected' THEN 'reject' ELSE p_action END;
    rnote := coalesce(nullif(btrim(item ->> 'note'), ''), nullif(btrim(p_note), ''));
    IF r.eff_decision = 'approved' OR r.eff_decision = 'rejected' THEN CONTINUE; END IF;
    -- a held row has no record yet: "approve all" lists it and leaves it; a return takes it back to the uploader
    IF r.register_record_id IS NULL THEN
      IF act = 'reject' THEN
        IF rnote IS NULL THEN PERFORM public.wf_err('note_required'); END IF;
        -- the same authority as returning a record: the uploader (taking the row back) or an L2 holder of the register row in the row's region
        IF actor <> b.uploaded_by AND NOT EXISTS (
             SELECT 1 FROM public.reg_eligible_cell(public.reg_cell_row(b.register_key, r.region_id, 'approve'), r.region_id, public.reg_module(b.register_key), 'approve') e
             WHERE e.user_id = actor) THEN
          BEGIN
            PERFORM public.wf_err('not_eligible_holder', jsonb_build_object('detail', 'Only the uploader or an L2 holder of this register can return the row.'));
          EXCEPTION WHEN others THEN
            first_forbidden := coalesce(first_forbidden, SQLERRM);
          END;
          failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'not_eligible_holder',
            'message', 'Only the uploader or an L2 holder of this register can return the row.'));
          CONTINUE;
        END IF;
        UPDATE public.import_batch_rows SET decision = 'rejected', decided_by = actor, decided_at = now(), decision_note = rnote, hold_reason = NULL WHERE id = r.id;
        decided := decided + 1; rejected := rejected + 1;
      ELSE
        held := held || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'reason', coalesce(r.hold_reason, 'open_version'),
          'record_id', (SELECT x.id FROM public.register_records x WHERE x.entity_id = r.matched_entity_id AND x.state IN ('entry', 'in_review', 'in_approval') LIMIT 1)));
      END IF;
      CONTINUE;
    END IF;
    IF act = 'reject' AND rnote IS NULL THEN PERFORM public.wf_err('note_required'); END IF;
    BEGIN
      SELECT * INTO rec FROM public.register_records WHERE id = r.register_record_id;
      IF act <> 'reject' AND ((act = 'approve' AND rec.state <> 'in_approval') OR (act = 'review' AND rec.state <> 'in_review')) THEN
        failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', 'invalid_transition',
          'message', 'The record is ' || rec.state || ': ' || act || ' is not possible now.'));
        CONTINUE;
      END IF;
      PERFORM public.reg_transition_record(rec.id, rec.version, act, rnote, p_stepup, r.id);
      SELECT state INTO st FROM public.register_records WHERE id = rec.id;
      IF act = 'reject' THEN
        UPDATE public.import_batch_rows SET decision = 'rejected', decided_by = actor, decided_at = now(), decision_note = rnote, decided_role = act WHERE id = r.id;
        rejected := rejected + 1; decided := decided + 1;
      ELSIF st = 'approved' THEN
        UPDATE public.import_batch_rows SET decision = 'approved', decided_by = actor, decided_at = now(), decision_note = rnote, decided_role = act WHERE id = r.id;
        approved := approved + 1; decided := decided + 1;
      ELSE
        decided := decided + 1;     -- passed a level; the row stays open
      END IF;
    EXCEPTION WHEN others THEN
      IF SQLERRM LIKE 'wf:step_up_required%' THEN RAISE; END IF;
      j := public.imp_wf_json(SQLERRM);
      IF j ->> 'code' IN ('not_eligible_holder', 'action_forbidden') AND first_forbidden IS NULL THEN first_forbidden := SQLERRM; END IF;
      IF j IS NULL THEN
        INSERT INTO public.system_log (level, source, message, context, user_id)
        VALUES ('warn', 'template-check', 'import row could not be decided', jsonb_build_object('batch_id', p_batch, 'row_no', r.row_no, 'sqlstate', SQLSTATE, 'error', left(SQLERRM, 300)), actor);
      END IF;
      msg := CASE WHEN j IS NOT NULL THEN coalesce(j -> 'extra' ->> 'detail', j ->> 'code') ELSE 'The row could not be decided. See the System Log (template-check) for the technical reason.' END;
      failed := failed || jsonb_build_array(jsonb_build_object('row_id', r.id, 'row_no', r.row_no, 'key', r.row_key, 'code', coalesce(j ->> 'code', 'row_failed'), 'message', left(msg, 300)));
    END;
  END LOOP;
  PERFORM set_config('app.batch_row', '', true);
  IF decided = 0 AND first_forbidden IS NOT NULL THEN RAISE EXCEPTION '%', first_forbidden USING ERRCODE = 'P0001'; END IF;

  new_st := public.imp_status_of_after(p_batch);
  UPDATE public.import_batches SET status = new_st, version = version + 1, note = CASE WHEN p_action = 'reject' THEN coalesce(nullif(btrim(p_note), ''), note) ELSE note END,
    closed_at = CASE WHEN new_st IN ('approved', 'rejected') THEN now() ELSE closed_at END WHERE id = p_batch;
  INSERT INTO public.audit_log (action, entity_type, entity_id, after, reason, actor_id)
  VALUES ('import_batch_' || p_action, 'import_batch', p_batch::text,
          jsonb_build_object('scope', p_scope, 'decided', decided, 'approved', approved, 'rejected', rejected, 'held', jsonb_array_length(held), 'failed', jsonb_array_length(failed), 'status', new_st), p_note, actor);
  -- tell the uploader
  uploader := b.uploaded_by;
  IF uploader <> actor AND decided > 0 THEN
    INSERT INTO public.notifications (user_id, channel, kind, title, body, link)
    VALUES (uploader, 'in_app', 'import_batch', CASE WHEN p_action = 'reject' THEN 'Rows of your upload were returned' ELSE 'Rows of your upload were decided' END,
            b.file_name || ': ' || approved || ' approved, ' || rejected || ' returned' || CASE WHEN p_action = 'reject' AND p_note IS NOT NULL THEN '. ' || left(p_note, 200) ELSE '' END,
            '/registers/' || b.register_key || '/batches/' || p_batch::text);
  END IF;
  RETURN jsonb_build_object('decided', decided, 'approved', approved, 'rejected', rejected, 'held', held, 'failed', failed);
END $$;

-- the same owner and grants as 0037 (idempotent)
ALTER FUNCTION imp_decide_batch(uuid,int,text,text,jsonb,text,boolean) OWNER TO pmis_definer;
REVOKE ALL ON FUNCTION imp_decide_batch(uuid,int,text,text,jsonb,text,boolean) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pmis_app') THEN
    GRANT EXECUTE ON FUNCTION imp_decide_batch(uuid,int,text,text,jsonb,text,boolean) TO pmis_app;
  END IF;
END $$;
