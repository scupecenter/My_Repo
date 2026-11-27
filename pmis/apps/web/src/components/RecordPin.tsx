import { Pin } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { PINNED_RECORDS_MAX, togglePinRecord, useRecordMemory, visitRecord, type RecRef } from '@/lib/recordMemory';

/** Item 5: records the visit (recent list, last seen state) and shows the pin button of a record page. */
export function RecordPin({ rec, signature }: { rec: RecRef; signature: string }) {
  const { t } = useTranslation();
  const m = useRecordMemory();
  useEffect(() => { visitRecord(rec, signature); }, [rec.id, rec.code, rec.name, rec.path, signature]); // eslint-disable-line react-hooks/exhaustive-deps
  const on = m.pins.some((p) => p.id === rec.id);
  const full = !on && m.pins.length >= PINNED_RECORDS_MAX;
  return (
    <button type="button" className="btn btn-sm" data-testid="record-pin" aria-pressed={on} disabled={full}
      title={full ? t('records.pin_full', { max: PINNED_RECORDS_MAX }) : undefined}
      onClick={() => togglePinRecord(rec, signature)}>
      <Pin size={14} aria-hidden className={on ? 'fill-current text-accentText' : ''} />
      {t(on ? 'records.unpin' : 'records.pin')}
    </button>
  );
}
