import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useEntityChanges, type FieldChange } from '@/api/logs';
import { fmtDateTime } from '@/lib/time';
import { PersonTag } from '@/components/PersonTag';
import { ViaChip, valueText } from './bits';
import { useCanReadAudit } from './FieldHistory';

/** The changes of one save (one audit row), grouped, newest group first. */
export function groupChanges(items: FieldChange[]): { audit_id: number; at: string; head: FieldChange; changes: FieldChange[] }[] {
  const groups = new Map<number, FieldChange[]>();
  for (const c of items) groups.set(c.audit_id, [...(groups.get(c.audit_id) ?? []), c]);
  return [...groups.entries()].map(([audit_id, changes]) => ({ audit_id, at: changes[0]!.at, head: changes[0]!, changes }));
}

/**
 * Field-level before and after of a record, in its History tab. It shows only to a person who may read the Audit Log (the same rule as the field history
 * icon), and the server has already left out every field the person may not see. Read only.
 */
export function ChangeDiff({ entityType, entityId }: { entityType: string; entityId: string | null | undefined }) {
  const { t, i18n } = useTranslation();
  const can = useCanReadAudit();
  const q = useEntityChanges(entityType, entityId, can);
  if (!can || !entityId) return null;
  const ar = i18n.language.startsWith('ar');
  const groups = groupChanges(q.data ?? []);
  return (
    <div className="mt-3" data-testid="change-diff">
      <h4 className="mb-1 font-semibold">{t('logs.diff_title')}</h4>
      {q.isLoading && <p className="text-sm text-mute">{t('common.loading')}</p>}
      {q.isError && <p role="alert" className="text-sm text-lateInk">{t('errors.generic')}</p>}
      {q.isSuccess && groups.length === 0 && <p className="text-sm text-mute" data-testid="change-diff-empty">{t('logs.fh_empty')}</p>}
      <ol className="space-y-2">
        {groups.map((g) => (
          <li key={g.audit_id} className="rounded-md border border-line p-2 text-sm" data-testid={`change-group-${g.audit_id}`}>
            <div className="flex flex-wrap items-center gap-2 text-xs text-mute">
              {g.head.actor && <PersonTag name={g.head.actor.name} employeeId={g.head.actor.employee_id} />}
              <span dir="ltr">{fmtDateTime(g.at, i18n.language)}</span>
              <ViaChip via={g.head.via} />
            </div>
            <ul className="mt-1 space-y-1">
              {g.changes.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-1" dir="auto" data-testid={`change-${c.id}`}>
                  <span className="font-semibold">{(ar ? c.field_label_ar : c.field_label_en) || c.field}</span>
                  <span className="mono text-mute" data-testid={`change-old-${c.id}`}>{valueText(c.old_value)}</span>
                  <ArrowRight size={14} aria-hidden className="rtl:rotate-180" />
                  <span className="mono" data-testid={`change-new-${c.id}`}>{valueText(c.new_value)}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}
