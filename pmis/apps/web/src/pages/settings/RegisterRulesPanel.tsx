import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRegisterRules, useSetRegisterRules, type RegisterRules, type RuleSpec } from '@/api/registerRules';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';

type Change = { r: RegisterRules; spec: RuleSpec; value: boolean | string };

/** Settings > Register rules: the rules the database enforces for a register (an invoice must name its order, the supplier company, the currency). A reason is asked and the change is audited (0430). */
export function RegisterRulesPanel() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useRegisterRules();
  const set = useSetRegisterRules();
  const [chg, setChg] = useState<Change | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState<Record<string, string>>({});
  const ar = i18n.language === 'ar';
  const close = () => { setChg(null); setErr(null); };
  const submit = async (reason: string) => {
    if (!chg) return;
    setErr(null);
    try {
      await set.mutateAsync({ key: chg.r.register_key, version: chg.r.version, rules: { [chg.spec.key]: chg.value }, reason });
      toast(t('regrules.saved'));
      close();
    } catch (e) { setErr(errText(e, t)); }
  };
  const items = q.data?.items ?? [];
  return (
    <div className="card space-y-3 p-4" data-testid="register-rules-panel">
      <h2 className="font-bold">{t('regrules.title')}</h2>
      <p className="text-sm text-mute">{t('regrules.note')}</p>
      {q.isLoading && <p className="text-mute">{t('common.loading')}</p>}
      {items.map((r) => (
        <div key={r.register_key} className="space-y-2" data-testid={`regrules-${r.register_key}`}>
          <h3 className="font-semibold">{(ar && r.name_ar) || r.name_en}</h3>
          {(q.data?.catalogue ?? []).filter((s) => s.register_key === r.register_key).map((s) => {
            const cur = r.rules[s.key] ?? s.default;
            const label = (ar && s.label_ar) || s.label_en;
            return s.type === 'boolean' ? (
              <label key={s.key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" role="switch" data-testid={`regrule-${r.register_key}-${s.key}`} checked={cur === true} onChange={() => setChg({ r, spec: s, value: cur !== true })} />
                {label}
              </label>
            ) : (
              <div key={s.key} className="flex flex-wrap items-center gap-2 text-sm">
                <span>{label}</span>
                <input className="input w-28" data-testid={`regrule-${r.register_key}-${s.key}`} aria-label={label} value={text[`${r.register_key}.${s.key}`] ?? String(cur ?? '')} onChange={(e) => setText({ ...text, [`${r.register_key}.${s.key}`]: e.target.value })} />
                <button type="button" className="btn" data-testid={`regrule-save-${r.register_key}-${s.key}`} disabled={!(text[`${r.register_key}.${s.key}`] ?? '').trim() || text[`${r.register_key}.${s.key}`] === String(cur ?? '')}
                  onClick={() => setChg({ r, spec: s, value: (text[`${r.register_key}.${s.key}`] ?? '').trim() })}>{t('common.save')}</button>
              </div>
            );
          })}
          {Object.keys(r.other ?? {}).length > 0 && (
            <details className="rounded-md border border-line p-2" data-testid={`regrules-other-${r.register_key}`}>
              <summary className="cursor-pointer text-sm font-semibold">{t('regrules.other_title', { count: Object.keys(r.other ?? {}).length })}</summary>
              <p className="mt-1 text-xs text-mute">{t('regrules.other_note')}</p>
              <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
                {Object.entries(r.other ?? {}).map(([k, v]) => (
                  <div key={k} className="contents"><dt dir="ltr"><bdi>{k}</bdi></dt><dd dir="ltr"><bdi>{typeof v === 'string' ? v : JSON.stringify(v)}</bdi></dd></div>
                ))}
              </dl>
            </details>
          )}
        </div>
      ))}
      <FormDialog inline open={!!chg} onClose={close} testid="register-rules-dialog" title={chg ? t('regrules.change_title', { rule: (ar && chg.spec.label_ar) || chg.spec.label_en }) : ''} error={err} busy={set.isPending} onSubmit={(reason) => void submit(reason)} />
    </div>
  );
}
