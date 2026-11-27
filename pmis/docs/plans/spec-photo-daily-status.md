# Spec: photo fields in the Daily Plan and in Status Updates

Status: DRAFT-SPEC. Part of decision 32 (approved 2026-11-27 10:29). The place was named by the project lead on 2026-11-27 22:41: field visits and daily reports live inside the Daily Plan and inside Status Updates, plus any data updates in those places. There is no separate register.

## Requirement
- A photo field in the Daily Plan (per row, one row per site and day) and in Status Updates (per update).
- Configurable in Settings: mandatory or optional, minimum number of photos.
- The photos appear automatically in the Gallery.

## Finding
Document slots today have two owners: a task or a register record (document_slots_one_owner, migration 0046). A daily plan row (daily_plan_rows) and a status update (status_updates) are neither, so they need a third owner kind. That means additive columns on document_slots with the owner check widened, placements for the new owner kinds, upload, withdrawal and list endpoints, the region rules of the owner, the slot panel on both screens, and an entry in the data-reset plan for any new column.

## Numbering reserved
Migration 0471 (range 0470-0489). Take the next free number at build time.

## Rules that apply
No isolated feature; Settings for everything configurable; additive migrations; hide, never delete; EN and AR walkthrough with screenshots.
