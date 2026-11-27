import { useTranslation } from 'react-i18next';
import { useDownloadLocks, useSecurityLocks } from '@/api/settings';

/**
 * What the admin lock keys switch off (migrations 0290 and 0293), read by every screen that builds or fetches a file. The server is the real gate for the routes it
 * serves (403 `export_locked` or `download_locked`); this hook lets a screen show the button disabled, with the reason, instead of failing after a click. For a file the
 * browser builds itself (CSV from the rows on screen, print) it is the only gate there is, a UI guard. While the state is loading nothing is locked (the server still decides).
 */
export function useDownloadGate() {
  const { t } = useTranslation();
  const locks = useSecurityLocks().data, dl = useDownloadLocks().data;
  const exportLocked = locks?.disable_export === true;
  return {
    /** A file or print the browser builds from data on screen, and every export route. */
    exportLocked,
    templatesLocked: dl?.templates === true,
    filesLocked: dl?.uploaded_files === true,
    generatedLocked: dl?.generated_documents === true,
    /** The tooltip of a locked button (undefined while it is open). */
    note: (locked: boolean) => (locked ? t('dllocks.locked_note') : undefined),
  };
}
