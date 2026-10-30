import * as Dialog from '@radix-ui/react-dialog';
import { Ban, Check, HandMetal, Save, Undo2, UserMinus, X, Clock, Link2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useSession } from '@/api/hooks';
import { useCreateRecord, useRecordClaim, useRecordHistory, useRecordOp, useRegisterRecord, useUpdateRecord, type RecordOp } from '@/api/registers';
import { useMatrix } from '@/api/sites';
import type { RegisterDefinition, RegisterRecord } from '@/api/types';
import { registerErrorMessage, serverFieldIssues } from '@/lib/registerErrors';
import { defaultsFor, OWNER_NOTE, sectionsFor, validateRecord, visibleData, type FieldIssue } from '@/lib/registerForms';
import { tripoliToday } from '@/lib/today';
import { FieldInput, fieldLabel, issueText, showValue, SitePicker } from './RegisterFields';
import { Holders } from './HolderChip';
import { RejectDialog } from './RejectDialog';
import { useToast } from './Toast';

export const STATE_TONE: Record<string, string> = { entry: 'bg-lockBg text-lockInk', in_review: 'bg-waitBg text-waitInk', in_approval: 'bg-openBg text-openInk', approved: 'bg-doneBg text-doneInk', voided: 'bg-lateBg text-lateInk' };
type Data = Record<string, unknown>;
type SiteSel = { id: string; code: string; region_id?: number } | null;

function Body({ def, record, onCreated }: { def: RegisterDefinition; record: RegisterRecord | null; onCreated: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const key = def.register_key;
  const lang = i18n.language;
  const session = useSession().data;
  const matrix = useMatrix().data;
  const create = useCreateRecord(key), update = useUpdateRecord(key), op = useRecordOp(key), claim = useRecordClaim(key);
  const hist = useRecordHistory(key, record?.id ?? null);
  const [data, setData] = useState<Data>(record?.data ?? defaultsFor(key));
  const [site, setSite] = useState<SiteSel>(record?.site_id ? { id: record.site_id, code: record.site_code ?? '', region_id: record.region_id as number | undefined } : null);
  const [rtype, setRtype] = useState<string>(record?.record_type ?? '');
  const [dirty, setDirty] = useState(false);
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<Record<string, FieldIssue>>({});
  const [rejecting, setRejecting] = useState(false);
  const [voiding, setVoiding] = useState(false);

  const act = (a: string) => !!record?.allowed_actions?.includes(a as never);
  const editable = !record || act('edit');
  const issues = { ...validateRecord(def, data, site?.id ?? null, tripoliToday()), ...server };
  const issueList = Object.keys(issues);
  const labelOf = (code: string) => { const f = def.fields.find((x) => x.code === code); return f ? fieldLabel(f, lang) : code; };
  const sections = sectionsFor(def, data);
  const set = (code: string, v: unknown) => { setData((d) => ({ ...d, [code]: v })); setDirty(true); setServer((s) => { const n = { ...s }; delete n[code]; return n; }); };
  const fail = (e: unknown) => { setServer(serverFieldIssues(e)); const m = registerErrorMessage(t, e); if (m) toast(m, 'err'); };
  const name = (i18n.language === 'ar' && def.name_ar) || def.name_en;

  // B5 / B6 preview from the Matrix row: who holds the next levels as well.
  const row = matrix?.stages.find((s) => s.code === key);
  const me = session?.user?.employee_id;
  const holds = (l: number) => !!row?.cells.find((c) => c.level === l)?.assignees.some((a) => a.kind === 'user' && a.employee_id === me);
  const n = record?.levels_required ?? row?.approval_levels ?? def.approval_levels;
  const from = record && record.state !== 'entry' ? record.current_level ?? 2 : 1;
  let next = from + 1;
  while (me && next <= n && holds(next)) next += 1;
  const finalSelf = !!me && holds(from) && next > n && n > 1 || (n === 1 && holds(1));
  const skipTo = me && holds(from) && next > from + 1 && next <= n ? next : null;

  const save = () => {
    setTried(true);
    if (!site && def.site_scoped) { setServer({ site_id: { code: 'site_required' } }); return; }
    const body = visibleData(def, data);
    if (!record) create.mutate({ site_id: site?.id, site_code: site?.code, region_id: site?.region_id, ...(rtype ? { record_type: rtype } : {}), data: body }, {
      onSuccess: (r) => { toast(t('registers.saved')); setDirty(false); onCreated(r.id); }, onError: fail,
    });
    else update.mutate({ record, patch: { data: body } }, { onSuccess: () => { toast(t('registers.saved')); setDirty(false); }, onError: fail });
  };
  const run = (o: RecordOp, r: RegisterRecord, note?: string) => op.mutate({ record: r, op: o, note }, {
    onSuccess: () => { toast(t(o === 'void' ? 'registers.voided' : 'approvals.done')); setRejecting(false); setVoiding(false); },
    onError: (e) => { setRejecting(false); setVoiding(false); fail(e); },
  });
  const submit = () => {
    setTried(true);
    if (issueList.length) return;
    if (!record) {
      create.mutate({ site_id: site?.id, site_code: site?.code, region_id: site?.region_id, ...(rtype ? { record_type: rtype } : {}), data: visibleData(def, data) }, {
        // the drawer switches to the saved record only after the submit answered, so the buttons below keep their callbacks
        onSuccess: (r) => op.mutate({ record: r, op: 'submit' }, { onSuccess: () => { toast(t('approvals.done')); onCreated(r.id); }, onError: (e) => { fail(e); onCreated(r.id); } }),
        onError: fail,
      });
    } else if (dirty) update.mutate({ record, patch: { data: visibleData(def, data) } }, { onSuccess: (r) => { setDirty(false); run('submit', r); }, onError: fail });
    else run('submit', record);
  };
  const busy = create.isPending || update.isPending || op.isPending || claim.isPending;
  const claimedBy = record?.ball_in_court?.claimed_by;
  const mine = claimedBy?.id === session?.user?.id;
  const canClaim = !!record && (act('review') || act('approve')) && !claimedBy && (record.ball_in_court?.holders.length ?? 0) > 1;
  const srcId = typeof record?.data.source_task_id === 'string' ? record.data.source_task_id : null;

  return (
    <div className="flex h-full flex-col" data-testid="register-drawer-body" data-state={record?.state ?? 'new'}>
      <header className="flex items-start gap-2 border-b border-line p-4">
        <div className="flex-1">
          <Dialog.Title className="font-bold">{name} · {record ? <span className="mono">{record.site_code ?? '—'}</span> : t('registers.new')}{record?.record_type && <span className="chip ms-2 bg-card2">{record.record_type.toUpperCase()}</span>}</Dialog.Title>
          <Dialog.Description className="mt-1 flex flex-wrap items-center gap-2 text-sm text-mute">
            {record ? <><span className={`chip ${STATE_TONE[record.state]}`} data-testid="reg-state">{t(`regState.${record.state}`)}</span>{t('drawer.level', { level: record.current_level ?? 1, total: n })}</> : t('registers.new_hint')}
          </Dialog.Description>
        </div>
        <Dialog.Close asChild><button className="btn px-2" aria-label={t('common.close')} data-testid="reg-close"><X size={16} /></button></Dialog.Close>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {OWNER_NOTE[key] && <p className="rounded-md bg-card2 p-3 text-sm" data-testid="reg-owner-note">{t(OWNER_NOTE[key])}</p>}
        {srcId && record?.site_id && (
          <p className="flex items-center gap-2 rounded-md bg-openBg p-3 text-sm text-openInk" data-testid="reg-source">
            <Link2 size={14} />{t('registers.source_task')}{' '}
            <Link className="font-semibold underline" data-testid="reg-source-link" to={`/sites/${record.site_id}?task=${srcId}`}>{String(record.data.source_task_code ?? t('registers.open_task'))}</Link>
          </p>
        )}
        {record?.last_return_note && record.state === 'entry' && <div className="rounded-md bg-lateBg p-3 text-sm text-lateInk" data-testid="reg-return-note">{t('approvals.returned_note', { note: record.last_return_note })}</div>}
        {record && record.state !== 'entry' && record.state !== 'approved' && record.state !== 'voided' && (
          <section aria-label={t('grid.ball')}>
            <div className="mb-1 text-sm text-mute">{t('grid.ball')}</div>
            <Holders holders={record.ball_in_court?.holders ?? []} />
            {claimedBy && <p className="mt-1 text-sm text-openInk" data-testid="reg-claimed-by">{t('drawer.claimed_by', { name: claimedBy.display_name })}</p>}
          </section>
        )}
        {record && (
          <ol className="flex flex-wrap gap-2 text-sm" data-testid="reg-path">
            {Array.from({ length: n }, (_, i) => i + 1).map((l) => {
              const kind = l === 1 ? 'entry' : l === n ? 'approve' : 'review';
              const st = record.state === 'approved' || l < (record.current_level ?? 1) || (l === 1 && record.state !== 'entry') ? 'done' : l === (record.current_level ?? 1) ? 'current' : 'pending';
              return <li key={l} data-status={st} className={`chip ${st === 'current' ? 'bg-openBg text-openInk' : st === 'done' ? 'bg-doneBg text-doneInk' : 'bg-lockBg text-lockInk'}`}>{l}. {t(`level.${kind}`)}</li>;
            })}
          </ol>
        )}

        <form onSubmit={(e) => e.preventDefault()} className="space-y-5" noValidate>
          {def.site_scoped && (
            <section aria-labelledby="rs-site" className="space-y-2">
              <h3 id="rs-site" className="font-semibold">{t('regSections.site')}</h3>
              <div><label htmlFor="reg-site" className="text-sm text-mute">{t('registers.site')} *</label>
                {editable && !record ? <SitePicker value={site} onChange={(s) => { setSite(s); setDirty(true); setServer((x) => { const m = { ...x }; delete m.site_id; return m; }); }} invalid={!!issues.site_id && tried} />
                  : <div className="mono font-semibold">{site?.code ?? '—'}</div>}
                {issues.site_id && tried && <p id="reg-site-error" role="alert" data-testid="reg-error-site_id" className="text-sm text-lateInk">{t(`regErrors.${issues.site_id.code}`, { defaultValue: t('regErrors.invalid', { field: t('registers.site') }) })}</p>}
              </div>
              {def.record_types && def.record_types.length > 0 && (
                <div><label htmlFor="reg-record-type" className="text-sm text-mute">{t('registers.record_type')}</label>
                  {editable && !record ? <select id="reg-record-type" data-testid="reg-record-type" className="input" value={rtype} onChange={(e) => { setRtype(e.target.value); setDirty(true); }}><option value="">{t('registers.choose')}</option>{def.record_types.map((x) => <option key={x} value={x}>{x.toUpperCase()}</option>)}</select>
                    : <div className="font-semibold">{rtype ? rtype.toUpperCase() : '—'}</div>}
                </div>
              )}
            </section>
          )}
          {sections.map((s) => (
            <section key={s.id} aria-labelledby={`rs-${s.id}`} data-testid={`reg-section-${s.id}`} className="space-y-2">
              <h3 id={`rs-${s.id}`} className="font-semibold">{t(`regSections.${s.id}`, { defaultValue: t('regSections.details') })}</h3>
              <div className="grid grid-cols-2 gap-3">
                {s.fields.map((f) => {
                  const iss = issues[f.code];
                  const show = iss && (tried || server[f.code] || dirty);
                  return (
                    <div key={f.code} className={f.type === 'text' && f.code === 'remark' ? 'col-span-2' : ''}>
                      <label htmlFor={`reg-field-${f.code}`} className="text-sm text-mute">{fieldLabel(f, lang)}{f.required ? ' *' : ''}</label>
                      {editable ? <FieldInput field={f} value={data[f.code]} onChange={(v) => set(f.code, v)} invalid={!!show} />
                        : <div className="font-semibold" data-testid={`reg-view-${f.code}`}>{showValue(f, data[f.code], lang, t)}</div>}
                      {f.code === 'has_expiry' && data.has_expiry === false && <span className="chip mt-1 bg-doneBg text-doneInk" data-testid="reg-permanent">{t('registers.permanent')}</span>}
                      {show && <p id={`reg-field-${f.code}-error`} role="alert" data-testid={`reg-error-${f.code}`} className="text-sm text-lateInk">{issueText(t, fieldLabel(f, lang), iss, labelOf)}</p>}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </form>

        {record && (
          <section aria-labelledby="rg-history">
            <h3 id="rg-history" className="mb-1 flex items-center gap-1 font-semibold"><Clock size={14} />{t('drawer.history')}</h3>
            <ol data-testid="reg-history" className="space-y-1 text-sm">
              {hist.data?.items.map((x) => <li key={x.id}>{t(`step.${x.action}`)} · L{x.level} · {x.acted_by?.display_name}{x.self_approval ? ` · ${t('drawer.self_approval')}` : ''}{x.note ? ` — ${x.note}` : ''}</li>)}
              {hist.isSuccess && !hist.data.items.length && <li className="text-mute">{t('drawer.no_history')}</li>}
              {hist.isError && <li className="text-mute">{t('registers.history_soon')}</li>}
            </ol>
          </section>
        )}
      </div>
      <footer className="space-y-2 border-t border-line p-4">
        {editable && (!record || act('submit')) && (finalSelf || skipTo) && <p className="text-sm text-waitInk" data-testid="reg-skip-note">{finalSelf ? t('drawer.self_approval_note') : t('drawer.skip_note', { level: skipTo })}</p>}
        {editable && tried && issueList.length > 0 && <p className="text-sm text-lateInk" data-testid="reg-missing">{t('registers.fix_list', { list: issueList.map((c) => (c === 'site_id' ? t('registers.site') : labelOf(c))).join(', ') })}</p>}
        <div className="flex flex-wrap gap-2">
          {record && act('void') && <button className="btn" data-testid="reg-void" disabled={busy} onClick={() => setVoiding(true)}><Ban size={16} />{t('registers.void')}</button>}
          {record && canClaim && <button className="btn" data-testid="reg-claim" disabled={busy} onClick={() => claim.mutate({ record, op: 'claim' }, { onError: fail })}><HandMetal size={16} />{t('drawer.claim')}</button>}
          {record && mine && <button className="btn" data-testid="reg-release" disabled={busy} onClick={() => claim.mutate({ record, op: 'release' }, { onError: fail })}><UserMinus size={16} />{t('drawer.release')}</button>}
          {record && act('reject') && <button className="btn btn-danger" data-testid="reg-reject" disabled={busy} onClick={() => setRejecting(true)}><Undo2 size={16} />{t('approvals.reject')}</button>}
          {editable && <button className="btn" data-testid="reg-save" disabled={busy || (!!record && !dirty)} onClick={save}><Save size={16} />{t('registers.save_draft')}</button>}
          {editable && (!record || act('submit')) && <button className="btn btn-primary ms-auto" data-testid="reg-submit" disabled={busy || (tried && issueList.length > 0)} onClick={submit}><Check size={16} />{finalSelf ? t('drawer.submit_final') : t('drawer.submit')}</button>}
          {record && act('review') && <button className="btn btn-primary ms-auto" data-testid="reg-review" disabled={busy} onClick={() => run('review', record)}><Check size={16} />{t('approvals.pass')}</button>}
          {record && act('approve') && <button className="btn btn-primary ms-auto" data-testid="reg-approve" disabled={busy} onClick={() => run('approve', record)}><Check size={16} />{t('approvals.approve')}</button>}
        </div>
      </footer>
      {record && <RejectDialog open={rejecting} title={t('approvals.reject_title', { site: record.site_code ?? name })} onClose={() => setRejecting(false)} onSend={(note) => run('reject', record, note)} />}
      {record && <RejectDialog open={voiding} title={t('registers.void_title')} onClose={() => setVoiding(false)} onSend={(note) => run('void', record, note)} />}
    </div>
  );
}

/** `recordId`: an id opens that record, 'new' opens an empty form, null is closed. */
export function RegisterDrawer({ def, recordId, onClose, onOpen }: { def: RegisterDefinition; recordId: string | null; onClose: () => void; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const isNew = recordId === 'new';
  const q = useRegisterRecord(def.register_key, isNew ? null : recordId);
  return (
    <Dialog.Root open={!!recordId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-scrim/50" />
        <Dialog.Content data-testid="register-drawer" aria-describedby={undefined} className="fixed inset-y-0 end-0 z-[60] w-[min(640px,100vw)] border-s border-line bg-card shadow-lg">
          {isNew ? <Body key="new" def={def} record={null} onCreated={onOpen} />
            : q.data ? <Body key={`${q.data.id}`} def={def} record={q.data} onCreated={onOpen} />
              : <div className="p-4"><Dialog.Title className="font-bold">{q.isError ? t('regErrors.not_found') : t('common.loading')}</Dialog.Title></div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
