import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, ArrowRightLeft, Ban, Check, FilePlus2, GitMerge, HandMetal, Inbox, Save, Undo2, UserMinus, X, Clock, Link2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useSession } from '@/api/hooks';
import { useCancelSnagRecord, useCreateRecord, useNewVersion, useRecordClaim, useRecordHistory, useRecordOp, useRecordTriage, useRecordTransfer, useRegisterRecord, useRegisterRecords, useUpdateRecord, useContractorCompanies, type RecordOp, type TriageOp } from '@/api/registers';
import { useMatrix } from '@/api/sites';
import { EditingNotice } from './EditingNotice';
import { useAddRegisterComment, useCommentReaction, useCommentResolved, useRegisterComments } from '@/api/x';
import type { RegisterDefinition, RegisterRecord } from '@/api/types';
import { registerErrorMessage, serverFieldIssues } from '@/lib/registerErrors';
import { cellLevel } from '@/lib/matrixLevels';
import { columnDefaults, defaultsFor, forEntry, forType, OWNER_NOTE, patchData, sectionsFor, typeData, typeRequired, validateRecord, visibleData, type FieldIssue } from '@/lib/registerForms';
import { tripoliToday } from '@/lib/today';
import { FieldHistory } from './logs/FieldHistory';
import { ChangeDiff } from './logs/ChangeDiff';
import { FieldInput, fieldLabel, issueText, showValue, SiteCodeField, SitePicker } from './RegisterFields';
import { CommentsPanel } from './Comments';
import { DrawerFrame, DrawerTabs, panelProps, useDrawerSettled, useReportDirty } from './DrawerFrame';
import { DraftBar, useDraft } from './DraftBar';
import { FollowButton } from './FollowButton';
import { RecordDocuments } from './RecordDocuments';
import { RelatedRecords } from './RelatedRecords';
import { AcquisitionSiteLocation } from './AcquisitionSiteLocation';
import { SiteTaskField } from './SiteTaskField';
import { SiteGateField } from './SiteGateField';
import { IssueRiskSelect, RiskIssues, DismantleOrderSelect, DismantleRnSelect, HlcPurchaseRequests, OrderReceipts, WarehouseOrderSelect, AdvanceSelect, SupplierSelect } from './P4cPanels';
import { useRecordSlots } from '@/api/documents';
import { Holders } from './HolderChip';
import { AdvanceChildren, Balance, ExtendBooking, MembersEditor, ReadinessBadge, reservedMessage, TopUp, VehiclePicker } from './AssignmentPanels';
import { LegacyConversion } from './LegacyConversion';
import { RejectDialog } from './RejectDialog';
import { useToast } from './Toast';

export const STATE_TONE: Record<string, string> = { entry: 'bg-lockBg text-lockInk', in_review: 'bg-waitBg text-waitInk', in_approval: 'bg-openBg text-openInk', approved: 'bg-doneBg text-doneInk', voided: 'bg-lateBg text-lateInk' };
/** 0.15.240: the intake-triage states of a record of a triage-enabled register (Issue Log, Change Control). */
export const TRIAGE_TONE: Record<string, string> = { pending: 'bg-waitBg text-waitInk', deferred: 'bg-waitBg text-waitInk', accepted: 'bg-doneBg text-doneInk', rejected: 'bg-lateBg text-lateInk', merged: 'bg-lockBg text-lockInk' };
type Data = Record<string, unknown>;
type SiteSel = { id: string; code: string; region_id?: number } | null;

/**
 * Migration 0042: the HLC record is linked to the approved HLC purchase request of the site (a Procurement record of scope HLC, filled by the server), and a
 * record entered before the move keeps its old request fields as a read-only block.
 */
function HlcPurchaseRequest({ record }: { record: RegisterRecord }) {
  const { t } = useTranslation();
  const d = record.data as Record<string, string | undefined>;
  return (
    <>
      <section className="rounded-md bg-card2 p-3 text-sm" data-testid="reg-hlc-pr" aria-label={t('registers.hlc_pr_title')}>
        <div className="mb-1 flex items-center gap-1 font-semibold"><Link2 size={14} />{t('registers.hlc_pr_title')}</div>
        {d.procurement_record_id ? (
          <>
            <Link className="font-semibold underline" data-testid="reg-hlc-pr-link" to={`/registers/procurement?record=${d.procurement_record_id}`}>{t('registers.hlc_pr_link', { pr: d.pr_no ?? '' })}</Link>
            <p className="text-mute" data-testid="reg-hlc-pr-approval">{d.hlc_approval_date ? t('registers.hlc_pr_approved', { date: d.hlc_approval_date }) : t('registers.hlc_pr_not_approved')}</p>
          </>
        ) : <p className="text-mute" data-testid="reg-hlc-pr-missing">{t('registers.hlc_pr_missing')}</p>}
      </section>
      {(d.request_no || d.request_date) && (
        <section className="rounded-md border border-line p-3 text-sm" data-testid="reg-hlc-legacy" aria-label={t('registers.hlc_legacy_title')}>
          <div className="font-semibold">{t('registers.hlc_legacy_title')}</div>
          <p className="text-mute">{t('registers.hlc_legacy_body', { no: d.request_no ?? '—', date: d.request_date ?? '—' })}</p>
        </section>
      )}
    </>
  );
}

/** Ordering issues that do not block (Q96): shown to everyone, meant for the reviewer. */
function Warnings({ record, labelOf }: { record: RegisterRecord; labelOf: (code: string) => string }) {
  const { t } = useTranslation();
  const list = record.warnings ?? [];
  if (!list.length) return null;
  return (
    <section className="rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="reg-warnings" aria-label={t('registers.warnings_title')}>
      <div className="mb-1 flex items-center gap-1 font-semibold"><AlertTriangle size={14} />{t('registers.warnings_title')}</div>
      <ul className="list-disc ps-5">
        {list.map((w, i) => {
          const field = w.path.replace(/^\/data\//, '');
          // 0.12.11: `related_path` names the field a GECOL date is compared with (Q151)
          const other = w.related_path ? labelOf(w.related_path.replace(/^\/data\//, '')) : '';
          return <li key={`${w.code}-${i}`} data-testid={`reg-warning-${w.code}`}>{t(`regWarnings.${w.code}`, { field: labelOf(field), other, defaultValue: w.message ?? w.code })}</li>;
        })}
      </ul>
    </section>
  );
}

/** 0.15.240: defer (note optional), reject (note) and merge (the surviving record + a note) all ask first; accept is one tap. */
function TriageDialog({ open, op, registerKey, selfId, onClose, onSend }: { open: boolean; op: TriageOp | null; registerKey: string; selfId: string; onClose: () => void; onSend: (note: string, duplicateOf?: string) => void }) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const [dup, setDup] = useState('');
  const [err, setErr] = useState('');
  const merging = op === 'merge';
  const list = useRegisterRecords(registerKey, { q: '', region_id: '', state: '', record_type: '' }, open && merging);
  const candidates = (list.data?.pages.flatMap((p) => p.items) ?? []).filter((r) => r.id !== selfId && r.state !== 'voided' && r.triage?.state !== 'merged' && r.triage?.state !== 'rejected');
  const send = () => {
    if (merging && !dup) { setErr('required'); return; }
    if ((op === 'reject' || merging) && !note.trim()) { setErr('note'); return; }
    onSend(note.trim(), merging ? dup : undefined);
  };
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid="triage-dialog" className="card fixed inset-x-0 top-1/4 z-[70] mx-auto w-[min(460px,92vw)] space-y-3 p-5">
          <Dialog.Title className="font-bold">{op ? t(`registers.triage_${op}_title`) : ''}</Dialog.Title>
          <Dialog.Description className="sr-only">{t('registers.triage_title')}</Dialog.Description>
          {merging && (
            <div>
              <label htmlFor="triage-dup" className="text-sm font-semibold">{t('registers.triage_merge_pick')} *</label>
              <select id="triage-dup" data-testid="triage-dup" className="input" value={dup} onChange={(e) => { setDup(e.target.value); setErr(''); }}>
                <option value="">{t('registers.choose')}</option>
                {candidates.map((r) => <option key={r.id} value={r.id}>{[r.site_code, r.record_type?.toUpperCase(), `v${r.version_no ?? 1}`].filter(Boolean).join(' · ')}</option>)}
              </select>
            </div>
          )}
          <div>
            <label htmlFor="triage-note" className="text-sm font-semibold">{op === 'defer' ? t('registers.triage_note_optional') : t('approvals.note')}</label>
            <textarea id="triage-note" data-testid="triage-note" className="input min-h-24" value={note} onChange={(e) => { setNote(e.target.value); setErr(''); }} />
          </div>
          {err && <p role="alert" data-testid="triage-error" className="text-lateInk">{err === 'note' ? t('approvals.note_required') : t('regErrors.required', { field: t('registers.triage_merge_pick') })}</p>}
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
            <button className={`btn ${op === 'reject' ? 'btn-danger' : 'btn-primary'}`} data-testid="triage-send" onClick={send}>{t('registers.triage_send')}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The record form, tabs and actions of a register record: the body of the drawer, and (decision V5) the body of the full record page. */
export function RegisterRecordBody({ def: rawDef, record, onCreated }: { def: RegisterDefinition; record: RegisterRecord | null; onCreated: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const key = rawDef.register_key;
  const lang = i18n.language;
  const rk = key;
  const session = useSession().data;
  const matrix = useMatrix().data;
  const create = useCreateRecord(key), update = useUpdateRecord(key), op = useRecordOp(key), cancelSnag = useCancelSnagRecord(), claim = useRecordClaim(key), newVersion = useNewVersion(key), transfer = useRecordTransfer(key), triageOp = useRecordTriage(key);
  const hist = useRecordHistory(key, record?.id ?? null);
  const comments = useRegisterComments(key, record?.id ?? '', !!record?.region_id);
  const addComment = useAddRegisterComment(key, record?.id ?? '');
  const reactComment = useCommentReaction(['register-comments', key, record?.id ?? '']);
  const resolveComment = useCommentResolved(['register-comments', key, record?.id ?? '']);
  // 0.12.5: a register with a file field reads the record's slots too (the slots of a record without a site come with Q228)
  const hasFile = rawDef.fields.some((f) => f.type === 'file');
  const recSlots = useRecordSlots(key, record && (record.site_id || hasFile) ? record.id : null);
  const ctx = { refs: record?.refs, files: (recSlots.data?.items ?? []).flatMap((sl) => sl.files.filter((f) => !f.superseded_by).map((f) => ({ id: f.id, name: f.original_name }))) };
  const docsMissing = record?.state === 'entry' ? (recSlots.data?.missing_for_submit ?? []) : [];
  // A10: a shortage row of the dashboard opens a new Procurement record with the site, the request type and a remark that names the item; nothing is saved until the person submits
  const [shortageSp] = useSearchParams();
  const fromShortage = !record && rawDef.register_key === 'procurement' && shortageSp.get('from') === 'shortage';
  const [data, setData] = useState<Data>(() => {
    const base = record?.data ?? defaultsFor(rawDef.register_key, rawDef);
    const remark = shortageSp.get('remark');
    return fromShortage && remark ? { ...base, remark: remark.slice(0, 500) } : base;
  });
  // 0.15.88: the Contractor company of a Procurement / GECOL / HLC record (record column external_party_id; Procurement picks it, GECOL and HLC show it read-only)
  const hasContractor = ['procurement', 'gecol', 'hlc', 'issues', 'quality'].includes(rawDef.register_key);
  const [party, setParty] = useState<string>(record?.external_party?.id ?? '');
  const companies = useContractorCompanies(rawDef.register_key === 'procurement');
  const [site, setSite] = useState<SiteSel>(fromShortage && shortageSp.get('site') ? { id: shortageSp.get('site') as string, code: shortageSp.get('site_code') ?? '' } : record?.site_id ? { id: record.site_id, code: record.site_code ?? '', region_id: record.region_id as number | undefined } : null);
  const [rtype, setRtype] = useState<string>(record?.record_type ?? (fromShortage ? 'pr' : ''));
  // 0.15.103: the columns prefilled from the admin's defaults on a new record; a column leaves the set when the person edits it
  const [prefilled, setPrefilled] = useState<Set<string>>(() => (record ? new Set() : new Set(Object.keys(columnDefaults(rawDef)))));
  const [dirty, setDirty] = useState(false);
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<Record<string, FieldIssue>>({});
  const [rejecting, setRejecting] = useState(false);
  const [triaging, setTriaging] = useState<TriageOp | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [tab, setTab] = useState('data');
  useReportDirty(dirty);
  const settle = useDrawerSettled();

  const act = (a: string) => !!record?.allowed_actions?.includes(a as never);
  const editable = !record || act('edit');
  // Q115: unsaved input is a server-side draft of this user only (never a save, a submission or an input of a calculation)
  const dr = useDraft(`record.${rawDef.register_key}.${record?.id ?? 'new'}`, { data, record_type: rtype }, dirty, editable);
  // 0042: the form offers only the scopes the caller may enter (the HLC Fiber Team: scope HLC); a read-only view shows the record as it is
  // 0.12.2 (Q222, D220b): the permit form offers only the permit types the caller may enter, and the streams they may choose for a purpose-based type
  // audit 2026-11-17 (C X2 / X3): a register with record types asks for the type on every new record (site-scoped or not, so a company, team,
  // contract, vehicle or booking is never created untyped), and the form shows only the fields of the chosen type
  const types = rawDef.record_types ?? [];
  const typeMissing = !record && types.length > 0 && !rtype && typeRequired(key);
  // an older record saved without a type keeps every field visible (nothing to choose from any more)
  const untypedRecord = !!record && !rtype;
  const base = editable ? forEntry(rawDef, data) : rawDef;
  const def = untypedRecord ? base : forType(base, rtype);
  const issues: Record<string, FieldIssue> = { ...validateRecord(def, data, site?.id ?? null, tripoliToday()), ...(typeMissing ? { record_type: { code: 'required' } } : {}), ...server };
  const issueList = Object.keys(issues);
  const typeLabel = (x: string) => t(`regTypes.${key}.${x}`, { defaultValue: x.toUpperCase() });
  const labelOf = (code: string) => { if (code === 'record_type') return t('registers.record_type'); const f = def.fields.find((x) => x.code === code); return f ? fieldLabel(f, lang) : code; };
  /** The values sent: those of the chosen record type only. */
  const typed = (d: Data) => (untypedRecord ? d : typeData(rawDef, rtype, d));
  const sections = sectionsFor(def, data);
  const set = (code: string, v: unknown) => { setPrefilled((p) => { if (!p.has(code)) return p; const n = new Set(p); n.delete(code); return n; }); setData((d) => ({ ...d, [code]: v })); setDirty(true); setServer((s) => { const n = { ...s }; delete n[code]; return n; }); };
  const fail = (e: unknown) => { setServer(serverFieldIssues(e)); const m = reservedMessage(t, e) ?? registerErrorMessage(t, e); if (m) toast(m, 'err'); };
  const name = (i18n.language === 'ar' && def.name_ar) || def.name_en;

  // B5 / B6 preview from the Matrix row: who holds the next levels as well.
  const row = matrix?.stages.find((s) => s.code === key);
  const me = session?.user?.employee_id;
  const n = record?.levels_required ?? row?.approval_levels ?? def.approval_levels;
  // position p of the path -> matrix cell: 1 entry, the last position is always cell 3 (approve), a 2-level path skips cell 2 (owner answer E1)
  const holds = (p: number) => !!row?.cells.find((c) => c.level === cellLevel(p, n) && !c.task_code && !c.region_id)?.assignees.some((a) => a.kind === 'user' && a.employee_id === me);
  const from = record && record.state !== 'entry' ? record.current_level ?? 2 : 1;
  let next = from + 1;
  while (me && next <= n && holds(next)) next += 1;
  const finalSelf = !!me && holds(from) && next > n && n > 1 || (n === 1 && holds(1));
  const skipTo = me && holds(from) && next > from + 1 && next <= n ? next : null;

  const save = () => {
    setTried(true);
    if (!site && def.site_scoped) { setServer({ site_id: { code: 'site_required' } }); return; }
    if (typeMissing) { setServer({ record_type: { code: 'required' } }); return; }
    const body = visibleData(def, typed(data));
    if (!record) create.mutate({ site_id: site?.id, site_code: site?.code, region_id: site?.region_id, ...(rtype ? { record_type: rtype } : {}), ...(party ? { external_party_id: party } : {}), data: body }, {
      onSuccess: (r) => { dr.clear(); toast(t('registers.saved')); setDirty(false); onCreated(r.id); }, onError: fail,
    });
    else update.mutate({ record, patch: { data: patchData(def, record.data, typed(data)), ...(party !== (record.external_party?.id ?? '') ? { external_party_id: party || null } : {}) } }, { onSuccess: () => { dr.clear(); toast(t('registers.saved')); setDirty(false); }, onError: fail });
  };
  const run = (o: RecordOp, r: RegisterRecord, note?: string) => op.mutate({ record: r, op: o, note }, {
    onSuccess: () => { toast(t(o === 'void' ? 'registers.voided' : 'approvals.done')); setRejecting(false); setVoiding(false); },
    onError: (e) => { setRejecting(false); setVoiding(false); fail(e); },
  });
  const submit = () => {
    setTried(true);
    if (issueList.length) return;
    if (!record) {
      create.mutate({ site_id: site?.id, site_code: site?.code, region_id: site?.region_id, ...(rtype ? { record_type: rtype } : {}), ...(party ? { external_party_id: party } : {}), data: visibleData(def, typed(data)) }, {
        // the drawer switches to the saved record only after the submit answered, so the buttons below keep their callbacks
        onSuccess: (r) => op.mutate({ record: r, op: 'submit' }, { onSuccess: () => { toast(t('approvals.done')); settle(); onCreated(r.id); }, onError: (e) => { fail(e); settle(); onCreated(r.id); } }),
        onError: fail,
      });
    } else if (dirty) update.mutate({ record, patch: { data: patchData(def, record.data, typed(data)), ...(party !== (record.external_party?.id ?? '') ? { external_party_id: party || null } : {}) } }, { onSuccess: (r) => { setDirty(false); run('submit', r); }, onError: fail });
    else run('submit', record);
  };
  const busy = create.isPending || update.isPending || op.isPending || cancelSnag.isPending || claim.isPending || newVersion.isPending || transfer.isPending || triageOp.isPending;
  const triageState = record?.triage?.state;
  const triageWaiting = triageState === 'pending' || triageState === 'deferred';
  const triageRun = (o: TriageOp, note?: string, duplicateOf?: string) => {
    if (!record) return;
    triageOp.mutate({ record, op: o, note, duplicate_of: duplicateOf }, {
      onSuccess: () => { toast(t('registers.triage_done')); setTriaging(null); },
      onError: (e) => { setTriaging(null); fail(e); },
    });
  };
  const claimedBy = record?.ball_in_court?.claimed_by;
  const mine = claimedBy?.id === session?.user?.id;
  const canClaim = !!record && (act('review') || act('approve')) && !claimedBy && (record.ball_in_court?.holders.length ?? 0) > 1;
  const src = record?.task ?? null; // Q43: the task this record is the source of (set by the server at the first submission)

  return (
    <div className="flex h-full flex-col" data-testid="register-drawer-body" data-state={record?.state ?? 'new'}>
      <header className="flex items-start gap-2 border-b border-line p-4">
        <div className="flex-1">
          <Dialog.Title className="font-bold">{name} · {record ? <span className="mono">{record.site_code ?? '—'}</span> : t('registers.new')}{record?.record_type && <span className="chip ms-2 bg-card2">{typeLabel(record.record_type)}</span>}</Dialog.Title>
          <Dialog.Description className="mt-1 flex flex-wrap items-center gap-2 text-sm text-mute">
            {record ? <><span className={`chip ${STATE_TONE[record.state]}`} data-testid="reg-state">{t(`regState.${record.state}`)}</span>{t('drawer.level', { level: record.current_level ?? 1, total: n })}</> : t('registers.new_hint')}
          </Dialog.Description>
        </div>
        {record?.entity_id && <FollowButton target={{ kind: 'record', key, id: record.id }} entityId={record.entity_id} />}
        <Dialog.Close asChild><button className="btn px-2" aria-label={t('common.close')} data-testid="reg-close"><X size={16} /></button></Dialog.Close>
      </header>
      {record && <DrawerTabs value={tab} onChange={setTab} tabs={[{ id: 'data', label: t('drawer.tab_data') }, { id: 'documents', label: t('docs.tab') }, { id: 'comments', label: t('drawer.comments') }, { id: 'history', label: t('drawer.history') }]} />}
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <div {...panelProps('data', tab)} className="space-y-4">
        {record && <EditingNotice kind="record" id={record.id} editing={editable} testid="reg-editing-notice" />}
        {editable && <DraftBar draft={dr} onRestore={(v) => { if (v.data && typeof v.data === 'object') setData(v.data as Data); if (typeof v.record_type === 'string') setRtype(v.record_type); setDirty(true); }} />}
        {OWNER_NOTE[key] && <p className="rounded-md bg-card2 p-3 text-sm" data-testid="reg-owner-note">{t(OWNER_NOTE[key])}</p>}
        {src && record?.site_id && (
          <p className="flex items-center gap-2 rounded-md bg-openBg p-3 text-sm text-openInk" data-testid="reg-source">
            <Link2 size={14} />{t('registers.source_task')}{' '}
            <Link className="font-semibold underline" data-testid="reg-source-link" to={`/sites/${record.site_id}?task=${src.id}`}>{src.task_code}</Link>
          </p>
        )}
        {record && key === 'hlc' && <HlcPurchaseRequest record={record} />}
        {record && key === 'hlc' && <HlcPurchaseRequests record={record} />}
        {record && <Warnings record={record} labelOf={labelOf} />}
        {record && triageState && (
          <section className={`rounded-md p-3 text-sm ${triageWaiting ? 'bg-waitBg text-waitInk' : 'bg-card2'}`} data-testid="reg-triage" aria-label={t('registers.triage_title')}>
            <div className="mb-1 flex flex-wrap items-center gap-2 font-semibold">
              <Inbox size={14} />{t('registers.triage_title')}
              <span className={`chip ${TRIAGE_TONE[triageState]}`} data-testid="reg-triage-state">{t(`triageState.${triageState}`)}</span>
            </div>
            {triageWaiting && <p data-testid="reg-triage-hint">{t('registers.triage_hint')}</p>}
            {!triageWaiting && record.triage?.by && <p className="text-mute" data-testid="reg-triage-by">{t('registers.triage_decision_line', { action: t(`triageState.${triageState}`), name: record.triage.by.display_name, date: record.triage.at ?? '' })}</p>}
            {record.triage?.note && <p className="mt-1 whitespace-pre-line text-mute" data-testid="reg-triage-note">{record.triage.note}</p>}
            {record.triage?.duplicate_of && <Link className="mt-1 inline-block font-semibold underline" data-testid="reg-triage-dup" to={`/registers/${key}?record=${record.triage.duplicate_of}`}>{t('registers.triage_duplicate_of')}</Link>}
            {triageWaiting && act('triage') && (
              <div className="mt-2 flex flex-wrap gap-2">
                <button className="btn btn-primary" data-testid="triage-accept" disabled={busy} onClick={() => triageRun('accept')}><Check size={16} />{t('registers.triage_accept')}</button>
                <button className="btn" data-testid="triage-defer" disabled={busy} onClick={() => setTriaging('defer')}><Clock size={16} />{t('registers.triage_defer')}</button>
                <button className="btn" data-testid="triage-merge" disabled={busy} onClick={() => setTriaging('merge')}><GitMerge size={16} />{t('registers.triage_merge')}</button>
                <button className="btn btn-danger" data-testid="triage-reject" disabled={busy} onClick={() => setTriaging('reject')}><Ban size={16} />{t('registers.triage_reject')}</button>
              </div>
            )}
          </section>
        )}
        {record && act('transfer') && <p className="rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="reg-transfer-note">{t('registers.transfer_note')}</p>}
        {record && key === 'meetings' && <LegacyConversion record={record} canEdit={act('edit')} />}
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
            </section>
          )}
          {types.length > 0 && (
            <section aria-labelledby="rs-type" className="space-y-2" data-testid="reg-section-type">
              {!def.site_scoped && <h3 id="rs-type" className="font-semibold">{t('registers.record_type')}</h3>}
              <div><label htmlFor="reg-record-type" id={def.site_scoped ? 'rs-type' : undefined} className="text-sm text-mute">{t('registers.record_type')}{typeRequired(key) ? ' *' : ''}</label>
                {editable && !record
                  ? <select id="reg-record-type" data-testid="reg-record-type" className="input" value={rtype} aria-invalid={!!issues.record_type && tried} aria-required={typeRequired(key)}
                      onChange={(e) => { setRtype(e.target.value); setDirty(true); setServer((x) => { const m = { ...x }; delete m.record_type; return m; }); }}>
                      <option value="">{t('registers.choose')}</option>{types.map((x) => <option key={x} value={x}>{typeLabel(x)}</option>)}
                    </select>
                  : <div className="font-semibold" data-testid="reg-view-record_type">{rtype ? typeLabel(rtype) : '—'}</div>}
                {issues.record_type && tried && <p role="alert" data-testid="reg-error-record_type" className="text-sm text-lateInk">{t('registers.type_required')}</p>}
              </div>
            </section>
          )}
          {sections.map((s) => (
            <section key={s.id} aria-labelledby={`rs-${s.id}`} data-testid={`reg-section-${s.id}`} className="space-y-2">
              <h3 id={`rs-${s.id}`} className="font-semibold">{t(`regSections.${s.id}`, { defaultValue: (lang === 'ar' && s.title_ar) || s.title })}</h3>
              <div className="grid grid-cols-2 gap-3">
                {s.fields.filter((f) => !(rk === 'warehouse' && f.code === 'procurement_order_id' && (!rtype || rtype === 'adj')) && !(rk === 'gecol' && f.code === 'contractor') && !(rk === 'procurement' && f.code === 'members') && !(rk === 'financial_advances' && f.code === 'balance')).map((f) => {
                  const iss = issues[f.code];
                  const show = iss && (tried || server[f.code] || dirty);
                  return (
                    <div key={f.code} className={(f.type === 'text' && f.code === 'remark') || ['child_list', 'multi_user', 'multi_site'].includes(f.type) ? 'col-span-2' : ''}>
                      <div className="flex items-center gap-1"><label htmlFor={`reg-field-${f.code}`} className="text-sm text-mute">{fieldLabel(f, lang)}{f.required ? ' *' : ''}</label>
                        {!record && prefilled.has(f.code) && <span className="chip bg-card2 text-[10px] text-mute" data-testid={`reg-prefilled-${f.code}`} title={t('registers.prefilled_hint')}>{t('registers.prefilled')}</span>}
                        {f.list?.status === 'pending' && <span className="chip bg-waitBg text-[10px] text-waitInk" data-testid={`reg-list-pending-${f.code}`} title={t('lists.pending_hint')}>{t('lists.pending')}</span>}
                        {record && <FieldHistory entityType="register_record" entityId={record.entity_id} field={f.code} label={fieldLabel(f, lang)} onRestore={editable && ['text', 'number', 'date', 'yes_no'].includes(f.type) ? (v) => set(f.code, v) : undefined} />}</div>
                      {rk === 'car_dispatcher' && f.code === 'vehicle_id'
                        ? <VehiclePicker value={data.vehicle_id} onChange={(v) => set('vehicle_id', v)} from={data.from_date as string} to={data.to_date as string} vehicleType={data.required_type as string} bookingId={record?.id} disabled={!editable} invalid={!!show} />
                        : ((rk as string) === 'rf_design' && (f.code === 'mw_far_end_site' || f.code === 'backup_site')) || (rk === 'risks' && f.code === 'affected_site_ids')
                        ? <SiteCodeField id={`reg-field-${f.code}`} value={data[f.code]} onChange={(v) => set(f.code, v)} multi={f.code === 'affected_site_ids'} naOption={f.code === 'mw_far_end_site'} selfCode={site?.code} disabled={!editable} invalid={!!show} />
                        : key === 'issues' && f.code === 'risk_entity_id'
                        ? <IssueRiskSelect value={data[f.code]} onChange={(v) => set(f.code, v)} editable={editable} invalid={!!show} />
                        : key === 'dismantle' && f.code === 'procurement_order_id'
                        ? <DismantleOrderSelect siteId={site?.id} part={rtype} value={data[f.code]} onChange={(v) => set(f.code, v)} editable={editable} invalid={!!show} />
                        : key === 'dismantle' && f.code === 'closing_rn_id'
                        ? <DismantleRnSelect siteId={site?.id} part={rtype} value={data[f.code]} onChange={(v) => set(f.code, v)} editable={editable} invalid={!!show} />
                        : ((key === 'issues' && f.code === 'blocked_gate_or_task') || (key === 'change_control' && f.code === 'affected_task_code') || (key === 'deliverables' && f.code === 'task_code'))
                        ? <SiteTaskField id={`reg-field-${f.code}`} siteId={site?.id} value={data[f.code]} onChange={(v) => set(f.code, v)} disabled={!editable} invalid={!!show} />
                        : key === 'deliverables' && f.code === 'gate_code'
                        ? <SiteGateField id={`reg-field-${f.code}`} siteId={site?.id} value={data[f.code]} onChange={(v) => set(f.code, v)} disabled={!editable} invalid={!!show} />
                        : (key === 'issues' || key === 'quality' || key === 'change_control') && f.code === 'procurement_order_id'
                        ? <WarehouseOrderSelect registerKey={key} field="procurement_order_id" siteId={site?.id} value={data[f.code]} onChange={(v) => set(f.code, v)} editable={editable} invalid={!!show} />
                        : (key === 'car_dispatcher' || key === 'financial_advances') && f.code === 'procurement_record_id'
                        ? <WarehouseOrderSelect registerKey={key} field="procurement_record_id" siteId={key === 'financial_advances' ? site?.id : null} value={data[f.code]} onChange={(v) => set(f.code, v)} editable={editable} invalid={!!show} />
                        : key === 'invoices' && f.code === 'procurement_record_id'
                        ? <WarehouseOrderSelect registerKey="invoices" field="procurement_record_id" siteId={site?.id} value={data[f.code]} onChange={(v) => set(f.code, v)} editable={editable} invalid={!!show} />
                        : key === 'invoices' && f.code === 'supplier_party_id'
                        ? <SupplierSelect value={data[f.code]} onChange={(v) => set(f.code, v)} editable={editable} invalid={!!show} />
                        : key === 'financial_advances' && f.code === 'advance_id'
                        ? <AdvanceSelect siteId={site?.id} value={data[f.code]} onChange={(v) => set(f.code, v)} editable={editable} invalid={!!show} />
                        : key === 'warehouse' && f.code === 'procurement_order_id'
                        ? <WarehouseOrderSelect siteId={site?.id} value={data[f.code]} onChange={(v) => set(f.code, v)} editable={editable} invalid={!!show} />
                        : editable && !(key === 'dismantle' && f.code === 'closing_rn_ref' && data.closing_rn_id) ? <FieldInput field={f} value={data[f.code]} onChange={(v) => set(f.code, v)} invalid={!!show} ctx={ctx} />
                        : f.type === 'child_list' ? <FieldInput field={f} value={data[f.code]} onChange={() => undefined} disabled ctx={ctx} />
                        : <div className="font-semibold whitespace-pre-line" data-testid={`reg-view-${f.code}`}>{showValue(f, data[f.code], lang, t, ctx)}</div>}
                      {f.code === 'has_expiry' && data.has_expiry === false && <span className="chip mt-1 bg-doneBg text-doneInk" data-testid="reg-permanent">{t('registers.permanent')}</span>}
                      {show && <p id={`reg-field-${f.code}-error`} role="alert" data-testid={`reg-error-${f.code}`} className="text-sm text-lateInk">{issueText(t, fieldLabel(f, lang), iss, labelOf)}</p>}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
          {hasContractor && (
            <section aria-labelledby="rs-contractor" data-testid="reg-section-contractor" className="space-y-2">
              <h3 id="rs-contractor" className="font-semibold">{t('registers.contractor')}</h3>
              {editable && rk === 'procurement' ? (
                <div><label htmlFor="reg-contractor" className="text-sm text-mute">{t('registers.contractor_company')}</label>
                  <select id="reg-contractor" data-testid="reg-contractor" className="input" value={party} onChange={(e) => { setParty(e.target.value); setDirty(true); }}>
                    <option value="">{t('registers.choose')}</option>
                    {(companies.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.scopes?.length ? ` (${c.scopes.join(', ')})` : ''}</option>)}
                    {party && !(companies.data ?? []).some((c) => c.id === party) && record?.external_party && <option value={party}>{record.external_party.name}</option>}
                  </select>
                  <p className="text-xs text-mute">{t('registers.contractor_hint')}</p>
                </div>
              ) : <div className="font-semibold" data-testid="reg-view-contractor">{(rk === 'procurement' ? record?.external_party?.name : record?.procurement_contractor?.name) ?? '—'}</div>}
            </section>
          )}
        </form>
        {rk === 'procurement' && (
          <section aria-labelledby="rs-assignment" data-testid="reg-section-assignment" className="space-y-2">
            <h3 id="rs-assignment" className="font-semibold">{t('procAssign.title')}</h3>
            {record && <ReadinessBadge recordId={record.id} />}
            <MembersEditor value={data.members} onChange={(v) => set('members', v)} disabled={!editable} names={Object.fromEntries(Object.entries(record?.refs?.users ?? {}).map(([id, u]) => [id, (u as { display_name: string }).display_name]))} />
          </section>
        )}
        {record && rk === 'procurement' && record.state === 'approved' && <OrderReceipts entityId={record.entity_id as string} />}
        {record && key === 'risks' && <RiskIssues entityId={record.entity_id as string} />}
        {record && (def.register_key as string) === 'acquisition' && record.site_id && <AcquisitionSiteLocation siteId={record.site_id} data={record.data} />}
        {record && <RelatedRecords registerKey={rk} entityId={record.entity_id as string} />}
        {record && rk === 'financial_advances' && <Balance record={record} />}
        {record && rk === 'financial_advances' && record.record_type === 'advance' && record.state === 'approved' && <TopUp record={record} onDone={onCreated} />}
        {record && rk === 'financial_advances' && record.record_type === 'advance' && record.state === 'approved' && ['disbursed', 'settlement_in_progress'].includes(String((record.data as { advance_state?: string }).advance_state)) && <AdvanceChildren record={record} onDone={onCreated} />}
        {record && rk === 'car_dispatcher' && record.record_type === 'booking' && record.state === 'approved' && <ExtendBooking record={record} onDone={onCreated} />}
        </div>

        {record && (
          <div {...panelProps('documents', tab)}>
            {tab === 'documents' && <RecordDocuments record={record} />}
          </div>
        )}
        {record && (
          <div {...panelProps('comments', tab)}>
            {/* a global record (no region) has no thread yet: the server answers 422, so the box is not offered */}
            {record.region_id ? (
              <CommentsPanel items={comments.data?.items} loaded={comments.isSuccess} pending={addComment.isPending} error={addComment.isError ? registerErrorMessage(t, addComment.error) : null}
                onSend={(body, ids) => addComment.mutate({ body, ...(ids.length ? { mention_user_ids: ids } : {}) })}
                onReact={(commentId, emoji, on) => reactComment.mutate({ commentId, emoji, on })}
                onToggleResolved={(commentId, resolved) => resolveComment.mutate({ commentId, resolved })} />
            ) : <p className="text-mute" data-testid="reg-comments-global">{t('registers.comments_global')}</p>}
          </div>
        )}
        {record && (
          <section {...panelProps('history', tab)}>
            <h3 id="rg-history" className="mb-1 flex items-center gap-1 font-semibold"><Clock size={14} />{t('drawer.history')}</h3>
            <ol data-testid="reg-history" className="space-y-1 text-sm">
              {hist.data?.items.map((x) => <li key={x.id} data-previous-path={x.previous_path ? 'true' : undefined}>{t(`step.${x.action}`, { defaultValue: x.action })} · L{x.level} · {x.acted_by?.display_name}{x.self_approval ? ` · ${t('drawer.self_approval')}` : ''}{x.note ? ` — ${x.note}` : ''}{x.previous_path && <span className="chip ms-2 bg-lockBg text-lockInk" data-testid="history-previous-path">{t('drawer.previous_path')}</span>}</li>)}
              {hist.isSuccess && !hist.data.items.length && <li className="text-mute">{t('drawer.no_history')}</li>}
              {hist.isError && <li className="text-mute">{t('registers.history_soon')}</li>}
            </ol>
            <ChangeDiff entityType="register_record" entityId={record.entity_id} />
          </section>
        )}
      </div>
      <footer className="space-y-2 border-t border-line p-4">
        {editable && (!record || act('submit')) && (finalSelf || skipTo) && <p className="text-sm text-waitInk" data-testid="reg-skip-note">{finalSelf ? t('drawer.self_approval_note') : t('drawer.skip_note', { level: skipTo })}</p>}
        {docsMissing.length > 0 && (!record || act('submit')) && <p className="text-sm text-lateInk" data-testid="reg-docs-missing">{t('recDocs.missing', { list: docsMissing.join(', ') })}</p>}
        {editable && tried && issueList.length > 0 && <p className="text-sm text-lateInk" data-testid="reg-missing">{t('registers.fix_list', { list: issueList.map((c) => (c === 'site_id' ? t('registers.site') : labelOf(c))).join(', ') })}</p>}
        <div className="flex flex-wrap gap-2">
          {record && act('new_version') && <button className="btn" data-testid="reg-new-version" disabled={busy} onClick={() => newVersion.mutate(record, { onSuccess: (r) => { toast(t('registers.version_created')); onCreated(r.id); }, onError: fail })}><FilePlus2 size={16} />{t('registers.new_version')}</button>}
          {record && act('transfer') && <button className="btn" data-testid="reg-transfer" disabled={busy} onClick={() => transfer.mutate({ record }, { onSuccess: () => toast(t('registers.transferred')), onError: fail })}><ArrowRightLeft size={16} />{t('registers.transfer')}</button>}
          {record && act('void') && <button className="btn" data-testid="reg-void" disabled={busy} onClick={() => setVoiding(true)}><Ban size={16} />{t('registers.void')}</button>}
          {record && act('cancel_snag') && <button className="btn btn-danger" data-testid="reg-cancel-snag" disabled={busy} onClick={() => setCancelling(true)}><Ban size={16} />{t('registers.cancel_snag')}</button>}
          {record && canClaim && <button className="btn" data-testid="reg-claim" disabled={busy} onClick={() => claim.mutate({ record, op: 'claim' }, { onError: fail })}><HandMetal size={16} />{t('drawer.claim')}</button>}
          {record && mine && <button className="btn" data-testid="reg-release" disabled={busy} onClick={() => claim.mutate({ record, op: 'release' }, { onError: fail })}><UserMinus size={16} />{t('drawer.release')}</button>}
          {record && act('reject') && <button className="btn btn-danger" data-testid="reg-reject" disabled={busy} onClick={() => setRejecting(true)}><Undo2 size={16} />{t('approvals.reject')}</button>}
          {editable && <button className="btn" data-testid="reg-save" disabled={busy || (!!record && !dirty)} onClick={save}><Save size={16} />{t('registers.save_draft')}</button>}
          {editable && (!record || act('submit')) && <button className="btn btn-primary ms-auto" data-testid="reg-submit" disabled={busy || (tried && issueList.length > 0) || docsMissing.length > 0} onClick={submit}><Check size={16} />{finalSelf ? t('drawer.submit_final') : t('drawer.submit')}</button>}
          {record && act('review') && <button className="btn btn-primary ms-auto" data-testid="reg-review" disabled={busy} onClick={() => run('review', record)}><Check size={16} />{t('approvals.pass')}</button>}
          {record && act('approve') && <button className="btn btn-primary ms-auto" data-testid="reg-approve" disabled={busy} onClick={() => run('approve', record)}><Check size={16} />{t('approvals.approve')}</button>}
        </div>
      </footer>
      {record && <RejectDialog open={rejecting} title={t('approvals.reject_title', { site: record.site_code ?? name })} onClose={() => setRejecting(false)} onSend={(note) => run('reject', record, note)} />}
      {record && <TriageDialog open={!!triaging} op={triaging} registerKey={key} selfId={record.id} onClose={() => setTriaging(null)} onSend={(note, dup) => triaging && triageRun(triaging, note, dup)} />}
      {record && <RejectDialog open={voiding} title={t('registers.void_title')} onClose={() => setVoiding(false)} onSend={(note) => run('void', record, note)} />}
      {record && <RejectDialog open={cancelling} title={t('registers.cancel_snag_title')} onClose={() => setCancelling(false)}
        onSend={(reason) => cancelSnag.mutate({ record, reason }, { onSuccess: () => { toast(t('registers.cancel_snag_done')); setCancelling(false); }, onError: (e) => { setCancelling(false); fail(e); } })} />}
    </div>
  );
}

/** `recordId`: an id opens that record, 'new' opens an empty form, null is closed. `nav` = the ids of the list shown behind, for next/previous. */
export function RegisterDrawer({ def, recordId, onClose, onOpen, nav }: { def: RegisterDefinition; recordId: string | null; onClose: () => void; onOpen: (id: string) => void; nav?: string[] }) {
  const { t } = useTranslation();
  const isNew = recordId === 'new';
  const q = useRegisterRecord(def.register_key, isNew ? null : recordId);
  return (
    <DrawerFrame name="register" testid="register-drawer" wide={640} open={!!recordId} onClose={onClose} nav={nav && !isNew ? { ids: nav, current: recordId, onGo: onOpen } : undefined}>
      {isNew ? <RegisterRecordBody key="new" def={def} record={null} onCreated={onOpen} />
        : q.data ? <RegisterRecordBody key={`${q.data.id}`} def={def} record={q.data} onCreated={onOpen} />
          : <div className="p-4"><Dialog.Title className="font-bold">{q.isError ? t('regErrors.not_found') : t('common.loading')}</Dialog.Title></div>}
    </DrawerFrame>
  );
}

