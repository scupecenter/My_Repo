import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_RULES, needsValue, OPS_OF, RULE_TONES, TONE_CLASS, type FormatRule, type RuleKind, type RuleOp, type RuleTone } from '@/lib/condFormat';
import { Tip } from './Tip';

export type FormatCol = { id: string; label: string; kind: RuleKind; options?: { value: string; label: string }[] };

/** The text of a rule, in the person's language ("Due date: more than 7 days past"). */
export function ruleText(r: FormatRule, cols: FormatCol[], t: (k: string, o?: Record<string, unknown>) => string): string {
  const c = cols.find((x) => x.id === r.col);
  const val = c?.options?.find((o) => o.value === String(r.value))?.label ?? r.value;
  return `${c?.label ?? r.col}: ${t(`fmt.op_${r.op}`, { value: val })}`;
}

/**
 * Conditional formatting rules of a table (decision 2026-11-28), a section of the Layout panel: "when this column meets this condition, colour the
 * cell or the whole row". The first rule that matches wins, so the list has an order. The rules are the person's own (this browser, and saved with a
 * view); they only change how a value is drawn.
 */
export function FormatRulesEditor({ testid, rules, cols, onChange }: { testid: string; rules: FormatRule[]; cols: FormatCol[]; onChange: (r: FormatRule[]) => void }) {
  const { t } = useTranslation();
  const [col, setCol] = useState(cols[0]?.id ?? '');
  const c = cols.find((x) => x.id === col) ?? cols[0];
  const ops = c ? OPS_OF[c.kind] : [];
  const [op, setOp] = useState<RuleOp>(ops[0] ?? 'eq');
  const opNow = ops.includes(op) ? op : ops[0] ?? 'eq';
  const [value, setValue] = useState('');
  const [tone, setTone] = useState<RuleTone>('red');
  const [scope, setScope] = useState<'cell' | 'row'>('cell');
  if (!cols.length) return null;
  const numeric = c?.kind === 'number' || c?.kind === 'date';
  const ok = !needsValue(opNow) || (numeric ? value.trim() !== '' && Number.isFinite(Number(value)) : value.trim() !== '');
  const add = () => {
    if (!ok || rules.length >= MAX_RULES) return;
    onChange([...rules, { id: `r${Date.now().toString(36)}${rules.length}`, col: c!.id, op: opNow, ...(needsValue(opNow) ? { value: numeric ? Number(value) : value.trim() } : {}), tone, scope }]);
    setValue('');
  };
  const move = (i: number, d: -1 | 1) => { const j = i + d; if (j < 0 || j >= rules.length) return; const n = [...rules]; [n[i], n[j]] = [n[j]!, n[i]!]; onChange(n); };
  return (
    <div className="space-y-2 border-t border-line pt-2" data-testid={testid}>
      <div className="flex items-center gap-2 text-xs font-semibold text-mute">{t('fmt.title')}<Tip text={t('fmt.hint')}><span className="cursor-help rounded-full border border-line px-1.5 text-[10px]" tabIndex={0} aria-label={t('fmt.hint')}>?</span></Tip></div>
      {rules.length === 0 && <p className="text-xs text-mute" data-testid={`${testid}-none`}>{t('fmt.none')}</p>}
      <ul className="space-y-1">
        {rules.map((r, i) => (
          <li key={r.id} className="flex items-center gap-1 text-sm" data-testid={`${testid}-rule-${i}`}>
            <span className={`chip text-xs ${TONE_CLASS[r.tone]}`} data-tone={r.tone}>{t(`fmt.tone_${r.tone}`)}</span>
            <span className="min-w-0 flex-1 truncate" title={ruleText(r, cols, t)}>{ruleText(r, cols, t)}{r.scope === 'row' ? ` · ${t('fmt.scope_row')}` : ''}</span>
            <button type="button" className="btn px-1 py-0.5" aria-label={t('fmt.up')} disabled={i === 0} onClick={() => move(i, -1)} data-testid={`${testid}-up-${i}`}><ArrowUp size={12} /></button>
            <button type="button" className="btn px-1 py-0.5" aria-label={t('fmt.down')} disabled={i === rules.length - 1} onClick={() => move(i, 1)} data-testid={`${testid}-down-${i}`}><ArrowDown size={12} /></button>
            <button type="button" className="btn px-1 py-0.5" aria-label={t('fmt.remove')} onClick={() => onChange(rules.filter((x) => x.id !== r.id))} data-testid={`${testid}-del-${i}`}><Trash2 size={12} /></button>
          </li>
        ))}
      </ul>
      {rules.length < MAX_RULES ? (
        <div className="space-y-1.5 rounded-md border border-line p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <select className="input w-auto py-1 text-sm" aria-label={t('fmt.column')} data-testid={`${testid}-col`} value={c?.id} onChange={(e) => { setCol(e.target.value); setValue(''); }}>
              {cols.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
            <select className="input w-auto py-1 text-sm" aria-label={t('fmt.condition')} data-testid={`${testid}-op`} value={opNow} onChange={(e) => setOp(e.target.value as RuleOp)}>
              {ops.map((o) => <option key={o} value={o}>{t(`fmt.op_${o}`, { value: '…' })}</option>)}
            </select>
            {needsValue(opNow) && (c?.options && (opNow === 'eq' || opNow === 'ne')
              ? <select className="input w-auto py-1 text-sm" aria-label={t('fmt.value')} data-testid={`${testid}-value`} value={value} onChange={(e) => setValue(e.target.value)}><option value="" />{c.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
              : <input className="input w-24 py-1 text-sm" aria-label={t('fmt.value')} data-testid={`${testid}-value`} inputMode={numeric ? 'decimal' : 'text'} value={value} onChange={(e) => setValue(e.target.value)} />)}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {RULE_TONES.map((x) => (
              <label key={x} className={`chip cursor-pointer text-xs ${TONE_CLASS[x]} ${tone === x ? 'outline outline-2 outline-accent' : ''}`}>
                <input type="radio" className="sr-only" name={`${testid}-tone`} checked={tone === x} onChange={() => setTone(x)} data-testid={`${testid}-tone-${x}`} />{t(`fmt.tone_${x}`)}
              </label>
            ))}
            <select className="input ms-auto w-auto py-1 text-xs" aria-label={t('fmt.scope')} data-testid={`${testid}-scope`} value={scope} onChange={(e) => setScope(e.target.value as 'cell' | 'row')}>
              <option value="cell">{t('fmt.scope_cell')}</option><option value="row">{t('fmt.scope_row')}</option>
            </select>
            <button type="button" className="btn btn-primary px-2 py-1 text-xs" disabled={!ok} onClick={add} data-testid={`${testid}-add`}><Plus size={12} />{t('fmt.add')}</button>
          </div>
        </div>
      ) : <p className="text-xs text-mute">{t('fmt.max', { count: MAX_RULES })}</p>}
    </div>
  );
}
