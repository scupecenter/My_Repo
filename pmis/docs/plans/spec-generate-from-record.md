# Spec: generate a document from an approved register record

Status: DRAFT, API and database built in this PR (migration 0711, mirror db/sql/710); web button in the stacked web PR. Requested by the owner (voice, 2026-11-28 09:57 and 10:00, relayed by Main): a record that is uploaded and approved (a receipt, a handover) must be able to produce its document without retyping: press Generate on the record, the saved template opens filled with the site data and the record's own fields, and the document is placed in its predefined place. Part 1 (task documents: Generate, Open, Replace, unsigned generated copy inside the slot) is PR #553.

## What exists (main)
Library > Forms (0.15.70, migration 0151): `lib_preview` / `lib_generate` fill an approved HTML template with `lib_form_context` (site, region, task, doc, template, generated_by), number it from the form's sequence, keep it in `library_generated_docs` (task_id NOT NULL), audit it. Rights: L1 holder of the trigger task or grant `library.forms` create for the region, while the task is open. The signed copy is uploaded into the task's slot; L2 approves.

## Gap
1. The context has no record fields. 2. `library_generated_docs.task_id` is required, so a record-owned document has no home. 3. Record documents (RecordDocuments, slots keyed by `register_entity_id`) have no Generate button.

## Design (additive, one migration)
- `lib_form_context(..., p_record uuid DEFAULT NULL)` adds `record`: `{register_key, entity_id, status, level, fields: {<field_code>: value}, approved_at}`; field values are read through the existing field-permission filter (a column the caller may not read is not in the context). Placeholders `{{record.fields.<code>}}`, `{{#each record.lines}}` for line tables.
- `library_generated_docs` gets nullable `register_entity_id uuid` (FK to the record's entity, ON DELETE RESTRICT, covered by the data reset plan with the record's register part) and `task_id` becomes nullable with a CHECK that one of the two is set. No existing row changes.
- `POST /library/forms/{template_id}/generate` and `/preview` accept `record_id` instead of `site_id` (exactly one). The site comes from the record's site. Rights for a record: grant `library.forms` create for the region only (a record has no L1 task holder); the record must be approved at its final level; an editable (draft) record is refused with 422 `record_not_approved`.
- Template side: `trigger_register_key` (nullable) next to `trigger_task_code`; a template has one or the other.
- Placement: the generated copy is its own unsigned entry on the record's slot of the same document type, exactly as in #553 (does not mark the slot uploaded; the signed, stamped upload and approval stay). Open and Replace on stored files already apply to record slots (same slot list).
- Web: `RecordDocuments` passes a generate context (record id) to `SlotList`; `GenerateDialog` takes `record` instead of the site picker. EN and AR.

## Safety (owner rules)
No permission, role, grant or default change; additive columns only; the data reset plan decision and `docs/ops/data-reset.md` row for any new table (none: only columns). Void stays step-up. Nothing public.

## Open questions for the owner (not blocking the draft)
1. Which registers and which templates first (receipt, handover: names of the templates and the exact fields on each)? 2. Is "approved at its final level" the right gate, or may a record in review generate? 3. May the generated copy be numbered per record or per site (today: per form sequence)?

## Tests planned
API: preview and generate from a record; refused for a draft record; field-permission filtering; sequence number; audit; data reset dry run counts the column rows. Web: dialog from a record slot; unsigned entry; slot status unchanged.

Changelog entry (PR body only): Registers: generate a document from an approved record, filled with the record's fields.

## As built (differences from the design above)
- No FK on `register_entity_id`: `register_records.entity_id` is not unique, so a FK is impossible. The column is nullable, with the CHECK that a task or a record owns the document.
- Four new functions (`lib_record_context`, `lib_check_generate_record`, `lib_preview_record`, `lib_generate_record`); the task-document functions are untouched. `lib_generated_json` uses LEFT JOINs (no task for a record document).
- Any approved template can be used for a record (`trigger_register_key` is left for the answer to open question 1, so no template-save change now).
- Register fields have no per-field permission (checked in 018); the whole record is read only by a holder of `library.forms` create for the record's region.
