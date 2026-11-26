import { useTranslation } from 'react-i18next';

/** The evidence of a date (owner decision 2026-11-26): `red` a document still has to be uploaded, `yellow` all uploaded but waiting for review or approval, `green` all approved. No dot when nothing is required. */
export interface EvidenceDotData { state: 'green' | 'yellow' | 'red'; need: number; approved: number; pending: number; missing: number; rejected: number; expired: number }

const TONE = { red: 'bg-late', yellow: 'bg-wait', green: 'bg-done' } as const;

/** A tiny dot, in the line of the text: it never makes the row or the cell taller. Read only; the words are in its tooltip and its accessible name. */
export function EvidenceDot({ docs, testid }: { docs?: EvidenceDotData | null; testid?: string }) {
  const { t } = useTranslation();
  if (!docs) return null;
  const why = t(`evidence.${docs.state}`, { need: docs.need, approved: docs.approved, pending: docs.pending, missing: docs.missing, rejected: docs.rejected, expired: docs.expired });
  return <span role="img" aria-label={why} title={why} data-testid={testid ?? 'evidence-dot'} data-state={docs.state} className={`ms-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full align-middle ${TONE[docs.state]}`} />;
}
