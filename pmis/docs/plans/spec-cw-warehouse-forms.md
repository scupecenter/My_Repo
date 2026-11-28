# Spec: the CW warehouse forms (DN, RN, PAC, FAC, snag list)

Status: DRAFT-SPEC (no code in this PR). Requested by the owner (voice, 2026-11-28 10:00, relayed by Main) as the second PR after "generate from the record". The contract already describes them (`/generated-forms`, `/form-templates`, `FormKind` dn, rn, pac, fac, snag_list; contract 0.15.70 says they "are not served yet").

## Recommendation: serve them through the Library, not a second stack
The Library already has what `/generated-forms` was specified to have: versioned HTML templates (Settings > Documents > Form templates, approve and retire with step-up), numbering from `doc_sequences`, the kept copy, print and download, void with step-up, audit, the Archive. Building a parallel `/generated-forms` PDF stack would duplicate all of it. So: the five CW forms are Library form templates plus a `lines` section in the form context. The `/generated-forms` paths stay in the contract as "superseded by Library forms" (a contract note, no removal) unless the owner prefers the separate PDF route.

## Design (additive, one migration)
- Context: `lib_form_context` gets `lines` (array) and `snags` when the template `kind` asks for them. DN: lines of the site's delivery note movements (`wh_movements` kind delivery with `wh_movement_lines`: item code, description, unit, quantity, serials). RN: the return movements. PAC: net quantities on site = DN minus RN per item (the `boq_lines` rule of the contract). FAC: the PAC lines plus acceptance fields. Snag list: open snags of the site with their warehouse lines (`snags`, `snag_photos` not included).
- Seeded templates: five DRAFT templates (never approved by the migration) with codes DN, RN, PAC, FAC, SNAG and the numbering patterns of the contract (example `DN-CW-TR-2026-0001`: `DN-CW-{REGION}-{YYYY}-{SEQ:4}`); an admin reviews and approves them in Settings (same path as any template). Until approved, nothing is generated.
- PAC rule: refused with 422 `open_snags` while an open CW snag exists on the site (a TE PAC is blocked by open TE snags the same way; TE forms stay deferred as the contract says).
- Rights, numbering, voiding, audit: unchanged Library rules (L1 holder of the trigger task or `library.forms` create for the region, while the task is open).
- Placement: the generated copy is the unsigned entry in the task document slot (PR #553); the signed scan is uploaded and goes through the 3-level approval as today.
- Web: no new screen: the forms appear in Library > Forms and in the task Documents tab through the existing Generate button; the dialog shows the lines table in the preview.
- Data reset: no new table (templates are configuration, generated copies are already `library_generated_docs`).

## Safety (owner rules)
No permission, role, grant or default-value change; templates are seeded as drafts; no deploy; additive migration only.

## Open questions for the owner (not blocking the draft)
1. The five HTML layouts (the current paper forms): provide the sample or accept a first generic layout. 2. Confirm the Library route instead of the separate PDF route. 3. FAC fields and who signs.

## Tests planned
API: each context (lines per form), PAC net rule, `open_snags` refusal, numbering, drafts cannot generate. Web: preview shows the lines.

Changelog entry (PR body only): Library: delivery note, return note, PAC, FAC and snag list forms with the site's warehouse lines.
