import { ShieldAlert } from 'lucide-react';
import { UnsavedGuard } from '@/lib/unsavedGuard';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { useMailPolicy, useSetMailPolicy } from '@/api/settings';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';

type Kinds = Record<string, { enabled: boolean; mode: string }>;
interface Draft { enabled: boolean; mode: string; domains: string; kinds: Kinds }

/**
 * Settings, Mail (migration 0364, contract 0.15.261): who may be mailed. A global switch, internal only or internal plus external, the internal domains, and a switch and
 * a mode per notification kind. System Admin only; saving needs a reason and step-up. Off by default for outside addresses; the security lock blocks them while it is on.
 */
export function MailPolicy() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useMailPolicy(), set = useSetMailPolicy();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState(false);
  if (q.isError && q.error instanceof ApiError && q.error.status === 403) return null;
  if (!q.data) return <QueryFallback queries={[q]} testid="mail-policy-loading" />;
  const cur = q.data;
  const base: Draft = { enabled: cur.enabled, mode: cur.mode, domains: cur.internal_domains.join(', '), kinds: cur.kinds as Kinds };
  const d = draft ?? base;
  const patch = (p: Partial<Draft>) => setDraft({ ...d, ...p });
  const kind = (k: string) => d.kinds[k] ?? { enabled: true, mode: 'inherit' };
  const setKind = (k: string, p: Partial<{ enabled: boolean; mode: string }>) => patch({ kinds: { ...d.kinds, [k]: { ...kind(k), ...p } } });
  const domains = d.domains.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(base);
  const errs = fieldErrors(set.error);
  return (
    <section className="card space-y-3 p-4" data-testid="page-mail-policy">
      <h2 className="font-bold">{t('mailPolicy.title')}</h2>
      <p className="text-sm text-mute">{t('mailPolicy.note')}</p>
      <p className="mono text-xs text-mute" data-testid="mail-policy-version">{t('scopeMatch.version', { version: cur.version })}{dirty && <span className="chip ms-2">{t('scopeMatch.unsaved')}</span>}</p>
      {cur.block_public_sharing && <div role="alert" className="flex gap-2 rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="mail-policy-lock"><ShieldAlert size={16} />{t('mailPolicy.lock')}</div>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="mail-policy-enabled" checked={d.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />{t('mailPolicy.enabled')}</label>
      <label className="block text-sm">{t('mailPolicy.mode')}
        <select className="input ms-2" data-testid="mail-policy-mode" value={d.mode} onChange={(e) => patch({ mode: e.target.value })}>
          <option value="internal_only">{t('mailPolicy.internal_only')}</option>
          <option value="internal_external">{t('mailPolicy.internal_external')}</option>
        </select>
      </label>
      <label className="block text-sm">{t('mailPolicy.domains')}
        <input className="input mt-1 w-full" dir="ltr" data-testid="mail-policy-domains" value={d.domains} onChange={(e) => patch({ domains: e.target.value })} placeholder="example.com, example.org" />
      </label>
      <p className="text-xs text-mute">{t('mailPolicy.domains_note')}</p>
      <ul className="grid gap-1" data-testid="mail-policy-kinds">
        {cur.catalogue.map((c) => (
          <li key={c.kind} className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" data-testid={`mail-policy-kind-${c.kind}`} checked={kind(c.kind).enabled} onChange={(e) => setKind(c.kind, { enabled: e.target.checked })} />
              <span className="mono text-xs" dir="ltr">{c.kind}</span></label>
            <select className="input" aria-label={c.kind} data-testid={`mail-policy-kind-mode-${c.kind}`} value={kind(c.kind).mode} onChange={(e) => setKind(c.kind, { mode: e.target.value })}>
              <option value="inherit">{t('mailPolicy.inherit')}</option>
              <option value="internal_only">{t('mailPolicy.internal_only')}</option>
              <option value="internal_external">{t('mailPolicy.internal_external')}</option>
            </select>
          </li>
        ))}
      </ul>
      {Object.keys(errs).map((p) => <p key={p} role="alert" className="text-xs text-lateInk" data-testid={`mp-err${p.replace(/\//g, '-')}`}>{p}: {errs[p]}</p>)}
      <UnsavedGuard scope="settings" dirty={dirty} needsReason label={t('ui.guard_settings')} onSave={(reason) => new Promise<boolean>((res) => set.mutate({ version: cur.version, reason, enabled: d.enabled, mode: d.mode as 'internal_only' | 'internal_external', internal_domains: domains, kinds: d.kinds as never }, { onSuccess: () => { setDraft(null); res(true); }, onError: () => res(false) }))} />
      <button className="btn btn-accent" data-testid="mail-policy-save" disabled={!dirty} onClick={() => setOpen(true)}>{t('common.save')}</button>
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="mail-policy-dialog" title={t('mailPolicy.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: cur.version, reason, enabled: d.enabled, mode: d.mode as 'internal_only' | 'internal_external', internal_domains: domains, kinds: d.kinds as never }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); } })}>
          <p className="text-sm text-mute">{t('mailPolicy.confirm_note')}</p>
        </FormDialog>
      )}
    </section>
  );
}
