# Appearance profiles (items 1-3 of the PM-platforms proposal)

Owner approval 2026-11-27 (WhatsApp, "implement the whole proposal"). Migration 0241, contract 0.15.191.

## What a profile is

Seven dimensions, each one changeable alone, applied app-wide at once:

| key | values | effect |
| --- | --- | --- |
| density | comfortable / standard / compact | layout scale (root font size scales every rem utility) |
| font_scale | small / standard / large | the fixed-pixel type (--text-*, --type-*) |
| radius | sharp / standard / rounded | corners (--radius-*) |
| motion | full / reduced | transitions and animations |
| icon_style | light / regular / bold | lucide stroke width |
| menu_style | default / rail / autohide | the side menu rail/pin mechanics |
| accent | default / teal / blue / violet / green / orange / red / amber | the accent colour on top of the UI design |

Ready-made presets (classic / comfortable / night / compact) fill all seven at once; night also switches the theme (saved through the profile like the theme button).

## Data

- `users.ui_prefs` jsonb, `{}` = follow the organization defaults. Additive.
- `ui_pref_options()` lists the dimensions and allowed values (the single list the API, the web pickers and the mocks read).
- `ui_pref_defaults()` is the built-in standard of every dimension.
- `ui_prefs_sanitize(jsonb)` keeps only known keys with allowed values.
- `ui_identity_cfg()` gains sanitized `defaults` inside `ui.identity`; `admin_set_ui_identity` gained a `defaults jsonb` argument (the old 4-argument form is dropped; the only caller is the settings service).
- `ui_effective_prefs(ui_prefs)`: the organization defaults overlaid with the personal choices while `allow_user_choice` holds, else the defaults alone.
- `idm_update_own_profile` accepts `ui_prefs`; locked -> 42501 `ui_prefs_locked` (the API maps it to 403 `field_read_only` / `appearance_choice_locked`); audited per dimension with before and after in `profile_updated`.

## API

- `User` and `MyProfile` carry `ui_prefs` (stored) and `appearance` (effective). `MyProfile.identity` and `UiIdentity` carry `defaults` and `pref_options`.
- `PATCH /me/profile` accepts `ui_prefs` (a subset); `PUT /settings/identity` accepts optional `defaults` (omitted keeps the current ones).

## Web

- `lib/appearance.ts` sanitizes, applies and caches the set (data-ui-* attributes on `<html>`; a dimension at its standard carries no attribute, so without a choice everything renders exactly as before). Boot paints the cached set, the Shell applies the server set when /me answers - no flash.
- `styles/appearance.css` holds the token blocks per attribute. Status colours never change.
- My profile > Appearance: every dimension select with live preview (painted, not saved), Apply (PATCH, audited) and Revert. The UI design and theme controls stay in Details.
- Settings > Identity & themes: the organization appearance defaults (System Admin or an all-regions settings delegate, reason, step-up, If-Match), next to the default design.
- menu_style reuses the existing rail (icons only) and pin (autohide) mechanics of the Shell; applied once per chosen value, the top-bar buttons still switch afterwards.

## Explicitly not in this slice

Item 4 (per-user sidebar order, badges, pins) and item 5 (the workspace logo) ship as their own PRs.
