import { FileWarning, Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { recordTarget, taskTarget, useRecordSlots, useTaskSlots } from '@/api/documents';
import type { RegisterRecord } from '@/api/types';
import { SlotList } from './DocSlots';

/**
 * The Documents section of the register drawer (owner answer Q131): the record's own slots, keyed on its logical record so every version shows the same
 * files, with the same upload, versions, withdraw, download and audit as a task's slots. A record that is the source of a task (Q43) keeps that task's
 * slots, shown here too.
 */
export function RecordDocuments({ record }: { record: RegisterRecord }) {
  const { t } = useTranslation();
  const key = record.register_key;
  const q = useRecordSlots(key, record.id);
  const taskId = q.data?.task_id ?? null;
  const taskSlots = useTaskSlots(taskId);
  if (!record.site_id) return <p className="text-mute" data-testid="rec-docs-global">{t('recDocs.global')}</p>;
  if (q.isLoading) return <p className="text-mute">{t('common.loading')}</p>;
  if (q.isError) return <p role="alert" className="text-lateInk" data-testid="rec-docs-error">{t('recDocs.error')}</p>;
  const missing = q.data?.missing_for_submit ?? [];
  const items = q.data?.items ?? [];
  return (
    <div className="space-y-4" data-testid="rec-docs">
      {missing.length > 0 && (
        <p className="flex items-center gap-2 rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="rec-docs-missing">
          <FileWarning size={14} />{t('recDocs.missing', { list: missing.join(', ') })}
        </p>
      )}
      <section aria-labelledby="rec-docs-own">
        <h3 id="rec-docs-own" className="mb-2 font-semibold">{t('recDocs.own')}</h3>
        {items.length ? <SlotList slots={items} target={recordTarget(key, record.id)} edit={record.state === 'entry'} />
          : <p className="text-mute" data-testid="rec-docs-none">{t('recDocs.none')}</p>}
      </section>
      {taskId && (
        <section aria-labelledby="rec-docs-task" data-testid="rec-docs-task">
          <h3 id="rec-docs-task" className="mb-1 flex items-center gap-1 font-semibold"><Link2 size={14} />{t('recDocs.task_title')}</h3>
          <p className="mb-2 text-sm text-mute">
            {t('recDocs.task_note')}{' '}
            <Link className="text-link underline" data-testid="rec-docs-task-link" to={`/sites/${record.site_id}?task=${taskId}`}>{record.task?.task_code ?? t('recDocs.open_task')}</Link>
          </p>
          {taskSlots.data && <SlotList slots={taskSlots.data} target={taskTarget({ id: taskId, site_id: record.site_id })} edit={record.state === 'entry'} />}
        </section>
      )}
    </div>
  );
}
