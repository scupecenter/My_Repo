import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { fieldErrors } from '@/lib/fields';
import { useErr } from '../wf/useErr';

/** The text of a failed column write: a stale version (412) first, then the code of the answer or of its first field error, then the generic texts. */
export function useColErr() {
  const { t } = useTranslation();
  const err = useErr();
  return (e: unknown): string => {
    if (e instanceof ApiError) {
      if (e.status === 412) return t('studio.columns.err.stale');
      for (const code of [e.code, ...Object.values(fieldErrors(e))]) {
        const k = `studio.columns.err.${code}`;
        if (t(k) !== k) return t(k);
      }
    }
    return err(e);
  };
}

/** An error already turned into text by `useColErr`, passed through a reason dialog (`useAsk`) as it is. */
export class ColError extends Error {}
/** The callbacks of a reason dialog with the failure turned into the text of a column write. */
export const colCb = (cb: { onSuccess: () => void; onError: (e: unknown) => void }, fmt: (e: unknown) => string) => ({ onSuccess: cb.onSuccess, onError: (e: unknown) => cb.onError(new ColError(fmt(e))) });
