import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { PipelineNode } from '@/api/types';

const COLOR = { done: 'var(--done)', current: 'var(--open)', late: 'var(--late)' } as Record<string, string>;
const CLS = { done: 'done', current: 'cur', late: 'late', planned: 'ghost', na: 'na', locked: 'ghost', awaiting_confirmation: 'cur' } as const;

function Ring({ p, color }: { p: number; color: string }) {
  const r = 31, C = 2 * Math.PI * r;
  return (
    <svg className="rg" viewBox="0 0 74 74" aria-hidden="true">
      <circle cx="37" cy="37" r={r} fill="none" stroke="var(--pipe)" strokeWidth="4" />
      <circle cx="37" cy="37" r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${C * p} ${C}`} style={{ transition: 'stroke-dasharray .6s ease' }} />
    </svg>
  );
}

type PipelineProps = { nodes: PipelineNode[]; selected?: string | null; onSelect?: (code: string) => void; stats?: (m: PipelineNode) => ReactNode; label?: (m: PipelineNode) => string; variant?: 'A' | 'B' };

/** The state as a sign as well as a colour (Q116: never colour alone). */
const SIGN: Record<string, string> = { done: '✓', current: '●', late: '!', planned: '○', na: '–', locked: '○', awaiting_confirmation: '●' };
const SEG_FILL: Record<string, string> = { done: 'bg-done', current: 'bg-open', late: 'bg-late', awaiting_confirmation: 'bg-open' };

/**
 * Variant B (owner answer Q116, preview): a flat segmented track. One segment per milestone, in order, filled to its progress; the name, the state
 * in words with a sign, and the percentage under it. Logical properties only, so it mirrors in Arabic; it scrolls sideways on a narrow screen
 * and uses the colour tokens of both themes. Stage order, gates and figures are those of variant A.
 */
function FlatTrack({ nodes, selected, onSelect, stats, label }: PipelineProps) {
  const { t, i18n } = useTranslation();
  const ms = nodes.filter((n) => n.kind === 'milestone');
  return (
    <div data-testid="pipeline" data-variant="B">
      <div className="overflow-x-auto pb-1">
        <ol className="flex min-w-[640px] gap-1" data-testid="pipe-track-b">
          {ms.map((m, i) => {
            const name = i18n.language === 'ar' && m.name_ar ? m.name_ar : m.name_en;
            const p = Math.max(0, Math.min(1, m.progress ?? 0));
            return (
              <li key={m.code} className="min-w-0 flex-1">
                <button type="button" data-testid={`pipe-node-${m.code}`} data-state={m.state}
                  className={`group block w-full rounded-md p-1 text-start transition-transform hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${selected === m.code ? 'bg-accentSoft' : ''}`}
                  aria-pressed={selected === m.code} aria-label={label ? label(m) : `${name}: ${t(`pipe.${m.state}`)}`} onClick={() => onSelect?.(m.code)}>
                  <div className={`relative h-3 overflow-hidden bg-lockBg ${i === 0 ? 'rounded-s-full' : ''} ${i === ms.length - 1 ? 'rounded-e-full' : ''}`} aria-hidden="true">
                    {m.state !== 'na' && <i className={`absolute inset-y-0 start-0 ${SEG_FILL[m.state] ?? 'bg-lock'}`} style={{ width: `${p * 100}%`, transition: 'width .6s ease' }} />}
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-xs">
                    <span aria-hidden="true" className={m.state === 'late' ? 'font-bold text-lateInk' : m.state === 'done' ? 'text-doneInk' : 'text-mute'}>{SIGN[m.state] ?? '○'}</span>
                    <span className="truncate font-semibold">{name}</span>
                  </div>
                  <div className="text-xs text-mute"><span className="tnum">{m.state === 'na' ? '–' : `${Math.round(p * 100)}%`}</span> · {t(`pipe.${m.state}`)}</div>
                  <div className="text-xs">{stats ? stats(m) : null}</div>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="legend">
        <span><i className="d" />{SIGN.done} {t('pipe.done')}</span><span><i className="o" />{SIGN.current} {t('pipe.current')}</span><span><i className="l" />{SIGN.late} {t('pipe.late')}</span><span><i className="g" />{SIGN.planned} {t('pipe.planned')}</span>
      </div>
    </div>
  );
}

/** Milestone pipeline in the dashboard style: progress rings on nodes, a gradient track, hover lift (variant A, the default); `variant="B"` is the flat track. */
export function Pipeline(props: PipelineProps) {
  if (props.variant === 'B') return <FlatTrack {...props} />;
  return <RingPipeline {...props} />;
}

function RingPipeline({ nodes, selected, onSelect, stats, label }: PipelineProps) {
  const { t, i18n } = useTranslation();
  const ms = nodes.filter((n) => n.kind === 'milestone');
  const n = ms.length || 1;
  const done = ms.filter((m) => m.state === 'done').length;
  const cur = ms.find((m) => m.state === 'current' || m.state === 'late');
  const width = Math.min(100, ((done + (cur?.progress ?? 0)) / n) * 100);
  return (
    <div data-testid="pipeline" data-variant="A">
      <div className="pipe">
        <div className="pipe-track" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
          <div className="pipe-line" style={{ insetInline: `${50 / n}%` }}><i style={{ width: `${width}%` }} /></div>
          {ms.map((m) => {
            const name = i18n.language === 'ar' && m.name_ar ? m.name_ar : m.name_en;
            const p = m.progress ?? 0, cls = CLS[m.state];
            return (
              <button key={m.code} type="button" data-testid={`pipe-node-${m.code}`} data-state={m.state} className={`st ${cls} ${selected === m.code ? 'sel' : ''}`}
                aria-pressed={selected === m.code} aria-label={label ? label(m) : `${name}: ${t(`pipe.${m.state}`)}`} onClick={() => onSelect?.(m.code)}>
                <div className="node">
                  {m.state !== 'planned' && m.state !== 'na' && <Ring p={p} color={COLOR[m.state] ?? 'var(--lock)'} />}
                  <b style={p >= 1 ? { fontSize: 15 } : undefined}>{m.state === 'na' ? '—' : `${Math.round(p * 100)}%`}</b>
                  <small>{t(`pipe.${m.state}`)}</small>
                </div>
                <div className="nm">{name}</div>
                <div className="stats">
                  {stats ? stats(m) : m.actual_date ? <span className="mono">{m.actual_date.slice(5)}</span> : m.planned_date ? <>{t('grid.plan')} <span className="mono">{m.planned_date.slice(5)}</span></> : null}
                  {!!m.variance_wd && <span className={m.variance_wd > 0 ? 'late' : ''}> {m.variance_wd > 0 ? '+' : ''}{m.variance_wd} {t('approvals.wd')}</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <div className="legend">
        <span><i className="d" />{t('pipe.done')}</span><span><i className="o" />{t('pipe.current')}</span><span><i className="l" />{t('pipe.late')}</span><span><i className="g" />{t('pipe.planned')}</span>
      </div>
    </div>
  );
}

export function MiniRail({ rail }: { rail: { code: string; state: string }[] }) {
  return <span className="mr" data-testid="mini-rail" aria-hidden="true">{rail.map((r) => <i key={r.code} className={r.state} title={r.code} />)}</span>;
}
