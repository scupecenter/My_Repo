# Unsaved-changes guard (Decision 11) / حماية التغييرات غير المحفوظة

**Setting:** `ui.features.unsaved_guard` (Settings > UI features). Migration 0401, contract 0.15.262. Component: `apps/web/src/lib/unsavedGuard.tsx`.

## Behaviour
Typed input is never lost silently. Cancel, close, Esc, backdrop click, in-app navigation and tab close ask: Stay, Discard, or Save (Save only where the screen can save with a reason). After a successful save the draft settles, so the app's own navigation is not blocked (FormDialog sent-ref, `useDrawerSettled`).

## Covered
FormDialog, InlinePanel, DrawerFrame and RegisterDrawer, about 30 Settings pages, Comments and Messages composers, Site 360 edits, Profile details/appearance/menu, DelayPeriods, DocumentsGrid.

## Excluded (reasons live in `src/lib/unsavedGuardCoverage.test.ts`)
Selector-state pages, single-cell edits, pages whose edits only happen in a FormDialog (covered by the dialog).

## Open gaps (follow-ups)
SlaRules, NavLayoutEditor, Profile password/email/phone forms, Matrix, Announcements/StatusUpdates composers.

## Tests
Vitest (provider, coverage map, updated Cancel flows), Playwright `e2e/unsaved-guard.spec.ts` EN and AR (screenshots with `SHOT_DIR`).
