import { Clock, MessageSquare, PenLine, Workflow } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRecordHistory } from '@/api/registers';
import { useRegisterComments } from '@/api/x';
import { useEntityChanges } from '@/api/logs';
import { fmtDateTime } from '@/lib/time';
import { CommentBody } from './Comments';
import { useCanReadAudit } from './logs/FieldHistory';

type Kind = 'comment' | 'step' | 'change';
type Row = { id: string; kind: Kind; at: string; who: string; body: React.ReactNode; reached?: string[] };

const show = (v: unknown): string => (v === null || v === undefined || v === '' ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * One chronological Activity list for a register record: comments (with the people each @mention reached), workflow steps and field changes.
 * It reads the same three sources as the Comments and History tabs (no new endpoint); field changes appear only for people who may read the Audit Log.
 */
export function RegisterActivity({ registerKey, recordId, entityId, hasThread }: { registerKey: string; recordId: string; entityId: string | null | undefined; hasThread: boolean }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [kind, setKind] = useState<'all' | Kind>('all');
  const canAudit = useCanReadAudit();
  const hist = useRecordHistory(registerKey, recordId);
  const comments = useRegisterComments(registerKey, recordId, hasThread);
  const changes = useEntityChanges('register_record', entityId, canAudit);
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const c of comments.data?.items ?? []) out.push({ id: `c-${c.id}`, kind: 'comment', at: c.created_at, who: c.author.display_name, body: <CommentBody text={c.body} />, reached: c.mentions?.map((m) => m.display_name) });
    for (const s of hist.data?.items ?? []) out.push({ id: `s-${s.id}`, kind: 'step', at: s.created_at, who: s.acted_by?.display_name ?? '', body: <>{t(`step.${s.action}`, { defaultValue: s.action })} · L{s.level}{s.note ? ` — ${s.note}` : ''}</> });
    for (const x of changes.data ?? []) out.push({ id: `f-${x.id}`, kind: 'change', at: x.at, who: x.actor?.name ?? '', body: <>{lang === 'ar' ? x.field_label_ar || x.field_label_en : x.field_label_en}: <span className="text-mute">{show(x.old_value)}</span> → <b>{show(x.new_value)}</b></> });
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }, [comments.data, hist.data, changes.data, lang, t]);
  const list = kind === 'all' ? rows : rows.filter((r) => r.kind === kind);
  const icon = { comment: MessageSquare, step: Workflow, change: PenLine } as const;
  const chips: Array<'all' | Kind> = canAudit ? ['all', 'comment', 'step', 'change'] : ['all', 'comment', 'step'];
  return (
    <section aria-labelledby="rg-activity" data-testid="reg-activity">
      <h3 id="rg-activity" className="mb-2 flex items-center gap-1 font-semibold"><Clock size={14} />{t('activity.title')}</h3>
      <div className="mb-2 flex flex-wrap gap-1" role="group" aria-label={t('activity.filter')}>
        {chips.map((k) => (
          <button key={k} type="button" aria-pressed={kind === k} data-testid={`activity-filter-${k}`} onClick={() => setKind(k)}
            className={`rounded-full border px-3 py-0.5 text-xs ${kind === k ? 'border-openInk bg-openBg text-openInk' : 'border-line text-mute hover:bg-hover'}`}>{t(`activity.kind_${k}`)}</button>
        ))}
      </div>
      <ol className="relative space-y-2 border-s border-line ps-4 text-sm" data-testid="activity-list">
        {list.map((r) => {
          const Icon = icon[r.kind];
          return (
            <li key={r.id} data-testid={`activity-${r.kind}`} className="relative">
              <span className="absolute -start-[25px] top-1 grid h-4 w-4 place-items-center rounded-full bg-card2 text-mute"><Icon size={10} aria-hidden /></span>
              <div className="text-xs text-mute"><b className="text-ink">{r.who}</b> · {fmtDateTime(r.at, lang)}</div>
              <div dir="auto">{r.body}</div>
              {!!r.reached?.length && <p className="text-xs text-mute" data-testid="activity-mentions">{t('mention.reached')}: {r.reached.join(', ')}</p>}
            </li>
          );
        })}
        {!list.length && (comments.isSuccess || hist.isSuccess || hist.isError) && <li className="text-mute" data-testid="activity-empty">{t('activity.empty')}</li>}
      </ol>
    </section>
  );
}
