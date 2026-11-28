# Spec: link triggers (cross-module triggers)

Choice: the trigger only proposes. It creates a row in `link_trigger_proposals` and a notification. It does not write to approved records.
Reason: approved register records are immutable versions. A new version must go through the approval chain and the responsibility matrix, so an entry holder applies the proposal with the existing `registers.newVersion` and `registers.update` calls, as themselves.

- Tables: `link_triggers` (opt-in per link, off by default) and `link_trigger_proposals`.
- Functions: `link_triggers_json`, `link_trigger_save`, `link_trigger_pending`, `link_trigger_preview` (dry run), `link_triggers_run` (daily job, audit row), `link_trigger_proposals_json`, `link_trigger_proposal_close`.
- Job result key: `linkProposals`.
- Reset: data_reset_plan patch and pmis_reset_owner grants for both tables.
- Contract 0.15.488, migration 0629.
- Web: Settings, Alerts, Link triggers (admin) and the page /link-proposals.
