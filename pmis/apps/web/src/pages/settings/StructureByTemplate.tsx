import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useTemplates, downloadTemplate } from '@/api/registers';
import { downloadStructureDifferences, useDecideStructure, useRevertStructure, useStructureProposals, useUploadStructure, type StructureItem, type StructureProposal } from '@/api/structureProposals';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { Tip } from '@/components/Tip';
import { useToast } from '@/components/Toast';
import { ICONS, ICON_PROPS } from '@/lib/icons';
import { fmtDateTime } from '@/lib/time';

const STATUS_CLS: Record<string, string> = { pending: 'text-warn', applied: 'text-ok', rejected: 'text-bad', reverted: 'text-mute', approved: 'text-ok' };

/** What an item does to the data, in words: the rows holding a value, and a type change that cannot convert. */
function effectOf(i: StructureItem, t: (k: string, o?: Record<string, unknown>) => string): string {
  const imp = (i.impact ?? {}) as { usage?: { records_with_value?: number }; conversion?: { failed?: number; convertible?: number } | null };
  const parts: string[] = [];
  if (i.create) return t('struct.effect_new');
  const used = imp.usage?.records_with_value ?? 0;
  parts.push(t('struct.effect_rows', { n: used }));
  if (imp.conversion) parts.push(imp.conversion.failed ? t('struct.effect_conv_bad', { n: imp.conversion.failed }) : t('struct.effect_conv_ok', { n: imp.conversion.convertible ?? 0 }));
  return parts.join('. ');
}

/**
 * Settings > Data > Edit through templates (contract 0.15.401, migration 0560; Data entry proposals S1 to S9). The live register templates (download, upload the edited
 * file, view the structure) and the structure proposals that an upload made. Excel never changes the register: the upload makes a proposal that a System Admin reviews
 * and approves (step-up); the approval applies the items through the column doors and a new template version is issued. The same component can be shown in the Data hub.
 */
export function StructureByTemplate() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const tpls = useTemplates();
  const props = useStructureProposals();
  const upload = useUploadStructure();
  const [file, setFile] = useState<File | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const ar = i18n.language.startsWith('ar');
  if (!tpls.data || !props.data) return <section className="card p-4" data-testid="page-structure"><QueryFallback queries={[tpls, props]} testid="struct-loading" /></section>;
  const regs = tpls.data.filter((x) => x.template_kind === 'register');
  const pending = props.data.filter((p) => p.status === 'pending');
  const open = props.data.find((p) => p.id === openId) ?? null;
  const nameOf = (x: { name_en: string; name_ar?: string | null }) => (ar && x.name_ar ? x.name_ar : x.name_en);
  const when = (iso: string) => fmtDateTime(iso, i18n.language);
  return (
    <section className="space-y-3" data-testid="page-structure">
      <div className="card space-y-3 p-4">
        <h2 className="font-bold">{t('struct.title')}</h2>
        <p className="rounded bg-waitBg p-2 text-sm text-waitInk" data-testid="struct-note">{t('struct.note')}</p>
        {pending.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded border border-line p-2 text-sm" data-testid="struct-pending-bar">
            <span className="font-bold text-warn">{t('struct.pending_n', { n: pending.length })}</span>
            {pending.slice(0, 5).map((p) => <button key={p.id} type="button" className="btn btn-ghost" data-testid={`struct-pending-${p.id}`} onClick={() => setOpenId(p.id)}>{p.register_key}</button>)}
          </div>
        )}
        <input ref={input} type="file" accept=".xlsx" className="hidden" data-testid="struct-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f); e.target.value = ''; }} />
        <table className="w-full text-sm" data-testid="struct-templates">
          <thead><tr className="text-mute"><th className="text-start">{t('struct.col_template')}</th><th className="text-start">{t('struct.col_register')}</th><th className="text-start">{t('struct.col_version')}</th><th className="text-start">{t('struct.col_state')}</th><th className="text-end">{t('struct.col_actions')}</th></tr></thead>
          <tbody>
            {regs.map((x) => {
              const mine = pending.filter((p) => p.register_key === x.register_key).length;
              const Dl = ICONS.downloadFile, Up = ICONS.upload, Cols = ICONS.columnMap;
              return (
                <tr key={x.template_id} data-testid={`struct-row-${x.template_id}`}>
                  <td><bdi>{nameOf(x)}</bdi> <span className="text-mute"><bdi>{x.template_id}</bdi></span></td>
                  <td><bdi>{x.register_key}</bdi></td>
                  <td>v{x.current_version}</td>
                  <td>{mine > 0 ? <span className="text-warn">{t('struct.pending_n', { n: mine })}</span> : <span className="text-mute">{t('struct.none_pending')}</span>}</td>
                  <td className="text-end">
                    <span className="inline-flex gap-1">
                      <Tip text={t('struct.download')}><button type="button" className="btn btn-ghost p-1" aria-label={t('struct.download')} data-testid={`struct-dl-${x.template_id}`} onClick={() => { void downloadTemplate(x.template_id).catch((e) => toast(errText(e, t))); }}><Dl {...ICON_PROPS} /></button></Tip>
                      <Tip text={t('struct.upload')}><button type="button" className="btn btn-ghost p-1" aria-label={t('struct.upload')} data-testid={`struct-up-${x.template_id}`} onClick={() => input.current?.click()}><Up {...ICON_PROPS} /></button></Tip>
                      <Tip text={t('struct.view')}><Link to={`/admin/settings/registers/columns?register=${x.register_key ?? ''}`} className="btn btn-ghost p-1" aria-label={t('struct.view')} data-testid={`struct-view-${x.template_id}`}><Cols {...ICON_PROPS} /></Link></Tip>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="card space-y-2 p-4" data-testid="struct-proposals">
        <h3 className="font-bold">{t('struct.proposals')}</h3>
        {props.data.length === 0 ? <p className="text-sm text-mute" data-testid="struct-none">{t('struct.no_proposals')}</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-mute"><th className="text-start">{t('struct.col_register')}</th><th className="text-start">{t('struct.col_status')}</th><th className="text-start">{t('struct.col_by')}</th><th className="text-start">{t('struct.col_at')}</th><th className="text-start">{t('struct.col_items')}</th><th /></tr></thead>
            <tbody>
              {props.data.map((p) => (
                <tr key={p.id} data-testid={`struct-p-${p.id}`}>
                  <td><bdi>{p.register_key}</bdi></td>
                  <td className={STATUS_CLS[p.status] ?? ''}>{t(`struct.status_${p.status}`)}{p.blocked_count > 0 && <span className="ms-1 text-bad">({t('struct.blocked_n', { n: p.blocked_count })})</span>}</td>
                  <td><bdi>{(p.submitted_by as { display_name?: string } | null)?.display_name ?? '-'}</bdi></td>
                  <td><bdi>{when(p.submitted_at)}</bdi></td>
                  <td>{Object.entries(p.summary).map(([k, n]) => `${t(`struct.chg_${k}`)} ${n}`).join(', ')}</td>
                  <td className="text-end"><button type="button" className="btn btn-ghost" data-testid={`struct-open-${p.id}`} onClick={() => setOpenId(p.id)}>{t('struct.review')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && <Review p={open} onClose={() => setOpenId(null)} />}
      <FormDialog open={!!file} onClose={() => setFile(null)} testid="struct-upload-dialog" title={t('struct.upload_title')} submitLabel={t('struct.upload_submit')} busy={upload.isPending} error={upload.isError ? errText(upload.error, t) : null}
        onSubmit={(reason) => { if (file) upload.mutate({ file, reason }, { onSuccess: (p) => { toast(t('struct.uploaded')); setFile(null); setOpenId(p.id); } }); }}>
        <p className="text-sm" data-testid="struct-upload-file"><bdi>{file?.name}</bdi></p>
        <p className="text-sm text-mute">{t('struct.upload_hint')}</p>
      </FormDialog>
    </section>
  );
}

function Review({ p, onClose }: { p: StructureProposal; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const decide = useDecideStructure();
  const revert = useRevertStructure();
  const [dlg, setDlg] = useState<'reject' | 'revert' | null>(null);
  const pending = p.status === 'pending';
  const fieldOf = (i: StructureItem) => Object.entries(i.patch).map(([k, v]) => {
    const was = i.from ? (i.from as Record<string, unknown>)[k === 'field_type' ? 'type' : k] : undefined;
    const show = (x: unknown) => (x === null || x === undefined || x === '' ? '-' : typeof x === 'boolean' ? t(x ? 'struct.yes' : 'struct.no') : String(x));
    return i.create ? `${k}: ${show(v)}` : `${k}: ${show(was)} → ${show(v)}`;
  });
  return (
    <section className="card space-y-3 p-4" data-testid="struct-review" aria-label={t('struct.review_title', { reg: p.register_key })}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 font-bold">{t('struct.review_title', { reg: p.register_key })} <span className={STATUS_CLS[p.status] ?? ''}>{t(`struct.status_${p.status}`)}</span></h3>
        <button type="button" className="btn btn-ghost" data-testid="struct-close" onClick={onClose}>{t('common.close')}</button>
      </div>
      <p className="text-sm"><bdi>{(p.submitted_by as { display_name?: string } | null)?.display_name ?? '-'}</bdi> · <bdi>{fmtDateTime(p.submitted_at, i18n.language)}</bdi> · <bdi>{p.reason}</bdi></p>
      {p.needs_two_people && <p className="rounded bg-waitBg p-2 text-sm text-waitInk" data-testid="struct-two">{t('struct.two_people')}</p>}
      <table className="w-full text-sm" data-testid="struct-items">
        <thead><tr className="text-mute"><th className="text-start">{t('struct.col_code')}</th><th className="text-start">{t('struct.col_change')}</th><th className="text-start">{t('struct.col_diff')}</th><th className="text-start">{t('struct.col_effect')}</th></tr></thead>
        <tbody>
          {p.items.map((i) => (
            <tr key={i.code} data-testid={`struct-item-${i.code}`} className={i.blocked ? 'bg-lateBg' : ''}>
              <td><bdi>{i.code}</bdi></td>
              <td>{i.changes.map((c) => t(`struct.chg_${c}`)).join(', ')}</td>
              <td><bdi>{fieldOf(i).join('; ')}</bdi></td>
              <td>{i.blocked ? <span className="font-bold text-bad" data-testid={`struct-blocked-${i.code}`}>{t('struct.blocked')}: {t(`struct.block_${i.blocked}`)}</span> : effectOf(i, t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {decide.isError && <p className="text-sm text-bad" role="alert" data-testid="struct-error">{errText(decide.error, t)}</p>}
      <div className="flex flex-wrap gap-2">
        {pending && <button type="button" className="btn btn-accent" data-testid="struct-approve" disabled={p.blocked_count > 0 || decide.isPending} title={p.blocked_count > 0 ? t('struct.approve_blocked') : undefined}
          onClick={() => decide.mutate({ id: p.id, action: 'approve' }, { onSuccess: () => toast(t('struct.applied')) })}>{t('struct.approve')}</button>}
        {pending && <button type="button" className="btn" data-testid="struct-reject" onClick={() => setDlg('reject')}>{t('struct.reject')}</button>}
        <button type="button" className="btn" data-testid="struct-diff" onClick={() => { void downloadStructureDifferences(p.id).catch((e) => toast(errText(e, t))); }}>{t('struct.differences')}</button>
        {p.status === 'applied' && <button type="button" className="btn" data-testid="struct-revert" onClick={() => setDlg('revert')}>{t('struct.revert')}</button>}
      </div>
      <FormDialog open={dlg === 'reject'} onClose={() => setDlg(null)} testid="struct-reject-dialog" title={t('struct.reject')} submitLabel={t('struct.reject')} busy={decide.isPending} error={decide.isError ? errText(decide.error, t) : null}
        onSubmit={(note) => decide.mutate({ id: p.id, action: 'reject', note }, { onSuccess: () => setDlg(null) })} />
      <FormDialog open={dlg === 'revert'} onClose={() => setDlg(null)} testid="struct-revert-dialog" title={t('struct.revert')} submitLabel={t('struct.revert')} busy={revert.isPending} error={revert.isError ? errText(revert.error, t) : null}
        onSubmit={(reason) => revert.mutate({ id: p.id, reason }, { onSuccess: () => { toast(t('struct.reverted')); setDlg(null); onClose(); } })}>
        <p className="text-sm text-mute">{t('struct.revert_hint')}</p>
      </FormDialog>
    </section>
  );
}
