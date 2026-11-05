import { AlertTriangle, MailCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { useMailKinds, useSetMailKinds } from '@/api/settings';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';

/**
 * Settings, Mail kinds (Q441, contract 0.14.2): which notification kinds are also mailed. System Admin only; saving needs a reason and step-up. The list is the kinds
 * the code writes, with the six go-live kinds (a person is asked to act) marked as recommended. Security alerts are mailed by their own rule and are not offered.
 */
export function MailKinds() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useMailKinds(), set = useSetMailKinds();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  if (q.isError && q.error instanceof ApiError && q.error.status === 403) return <p role="alert" className="card p-4 text-sm text-lateInk" data-testid="mail-kinds-forbidden">{t('mailKinds.forbidden')}</p>;
  if (!q.data) return <p>{t('common.loading')}</p>;
  const cur = q.data;
  const known = new Set(cur.catalogue.map((c) => c.kind));
  const base = cur.kinds.filter((k) => known.has(k));
  const sel = draft ?? base;
  const recommended = cur.catalogue.filter((c) => c.recommended).map((c) => c.kind);
  const errs = fieldErrors(set.error);
  const toggle = (k: string, on: boolean) => setDraft(on ? [...sel.filter((x) => x !== k), k] : sel.filter((x) => x !== k));
  // saving also drops the values of the setting that the code does not write (cur.unknown_kinds), so it is allowed after any change when there are some
  const dirty = draft !== null && (draft.length !== base.length || draft.some((k) => !base.includes(k)) || cur.unknown_kinds.length > 0);
  return (
    <section className="card space-y-3 p-4" data-testid="page-mail-kinds">
      <h2 className="font-bold">{t('mailKinds.title')}</h2>
      <p className="text-sm text-mute">{t('mailKinds.note')}</p>
      <p className="mono text-xs text-mute" data-testid="mail-kinds-version">{t('scopeMatch.version', { version: cur.version })}{dirty && <span className="chip ms-2">{t('scopeMatch.unsaved')}</span>}</p>
      {cur.unknown_kinds.length > 0 && (
        <div role="alert" className="flex gap-2 rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="mail-kinds-unknown"><AlertTriangle size={16} />{t('mailKinds.unknown', { kinds: cur.unknown_kinds.join(', ') })}</div>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" data-testid="mail-kinds-recommended" onClick={() => setDraft([...new Set([...sel, ...recommended])])}><MailCheck size={14} />{t('mailKinds.select_recommended')}</button>
        <button type="button" className="btn btn-ghost" data-testid="mail-kinds-none" onClick={() => setDraft([])}>{t('mailKinds.select_none')}</button>
      </div>
      <ul className="grid gap-1 sm:grid-cols-2" data-testid="mail-kinds-list">
        {cur.catalogue.map((c) => (
          <li key={c.kind}>
            <label className="flex items-start gap-2 rounded-md p-1 text-sm hover:bg-card2">
              <input type="checkbox" className="mt-1" data-testid={`mail-kind-${c.kind}`} checked={sel.includes(c.kind)} onChange={(e) => toggle(c.kind, e.target.checked)} />
              <span>
                <span className="font-semibold">{t(`mailKinds.kind.${c.kind}`, { defaultValue: c.kind })}</span>
                {c.recommended && <span className="chip ms-2 bg-doneBg text-doneInk" data-testid={`mail-kind-recommended-${c.kind}`}>{t('mailKinds.recommended')}</span>}
                <span className="mono block text-xs text-mute" dir="ltr">{c.kind}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {Object.keys(errs).filter((p) => p.startsWith('/kinds')).map((p) => <p key={p} role="alert" className="text-xs text-lateInk" data-testid={`err${p.replace(/\//g, '-')}`}>{t(`fieldError.${errs[p]}`, { defaultValue: errs[p] })}</p>)}
      <button className="btn btn-accent" data-testid="mail-kinds-save" disabled={!dirty} onClick={() => setOpen(true)}>{t('common.save')}</button>
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="mail-kinds-dialog" title={t('mailKinds.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: cur.version, kinds: sel, reason }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); } })}>
          <p className="text-sm text-mute">{t('mailKinds.confirm_note', { count: sel.length })}</p>
        </FormDialog>
      )}
    </section>
  );
}
