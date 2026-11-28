/**
 * The release notes shown on the What's new page (user menu). A feature that changes what people see adds one entry here in its own pull request,
 * newest first. `to` is the screen the note points to. The text lives in the i18n files under `whatsNewItems.<id>`.
 */
export type WhatsNewEntry = { id: string; date: string; to?: string };
export const WHATS_NEW: WhatsNewEntry[] = [
  { id: 'register_board_preview', date: '2026-11-28', to: '/registers' },
];
