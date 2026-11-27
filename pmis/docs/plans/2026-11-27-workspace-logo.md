# Workspace logo in the identity (proposal item 5)

Owner approval 2026-11-27 (the PM-platforms proposal, item 5). Migration 0243, contract 0.15.232, CHANGELOG WorkspaceLogo.

## Decision
The logo is organization identity, not a document: it does NOT go through the documents object storage (encryption + AV scanning machinery for user files). A small dedicated table `ui_assets` (key 'logo', mime png/jpeg/svg/webp, bytes capped at 256 KiB, enabled flag, per-row version) keeps it, written only through the audited doors `admin_put_ui_asset` / `admin_set_ui_asset_enabled` (guard trigger like settings_guarded_keys of 0072). Hide never delete: hiding disables the row; nothing is deleted.

## Flow
- Read: `ui_identity_state()` gains `logo` (metadata), so GET /settings/identity and every client see it; `GET /ui/assets/{key}` serves the bytes of an enabled asset to any signed-in user (404 otherwise), ETag = the asset version.
- Write: Settings > Identity, System Admin or an all-regions settings delegate, multipart `file` + `reason`, step-up, If-Match once a logo exists; an upload always enables; audited `ui_asset_update` with metadata only (never the bytes).
- Web: the sidebar (Shell) shows the logo instead of the built-in "G" badge, cached in localStorage (`pmis.identity.logo`) against boot flash; the Identity settings page previews, uploads, hides and shows with reason dialogs.

## Rejects
- Documents storage reuse: entangles a 200KB identity image with ClamAV/encryption/envelopes.
- Bytes in the settings JSON: would bloat every identity read.
