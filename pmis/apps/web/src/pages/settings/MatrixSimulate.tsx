import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useMatrix, useMatrixSimulation, useSites } from '@/api/sites';
import type { TaskDefinition } from '@/api/types';
import { QueryFallback } from '@/components/States';

/**
 * Settings > Workflow > Who approves? (contract 0.15.100). Read only: pick a site and a stage task or a register and see who would hold
 * L1 and L2 today (matrix cell, rule, holders, and the admin-path fallback). Nothing is written and nobody is notified.
 */
export function MatrixSimulateScreen() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language.startsWith('ar');
  const [search, setSearch] = useState('');
  const [siteId, setSiteId] = useState('');
  const [kind, setKind] = useState<'task' | 'register'>('task');
  const [code, setCode] = useState('');
  const matrix = useMatrix();
  const version = matrix.data?.workflow_version;
  const sites = useSites({ q: search, region_id: '', scenario: '', overall_status: '', stage_code: '' }, search.trim().length > 0);
  const tasks = useQuery({ queryKey: ['task-definitions', 'sim', version], enabled: kind === 'task' && version != null,
    queryFn: () => api.get<{ items: TaskDefinition[] }>('/settings/task-definitions', { query: { workflow_version: version } }).then((r) => r.items) });
  const sim = useMatrixSimulation(siteId, kind, code);
  const siteItems = sites.data?.pages.flatMap((p) => p.items) ?? [];
  const registers = (matrix.data?.stages ?? []).filter((r) => r.kind === 'register');
  const d = sim.data;
  return (
    <section className="card space-y-3 p-4" data-testid="page-matrix-simulate">
      <h2 className="font-bold">{t('matrixSimulate.title')}</h2>
      <p className="text-sm text-mute">{t('matrixSimulate.note')}</p>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">{t('matrixSimulate.site_search')}
          <input className="input" value={search} onChange={(e) => { setSearch(e.target.value); setSiteId(''); }} data-testid="ms-site-search" />
        </label>
        <label className="flex flex-col gap-1">{t('matrixSimulate.site')}
          <select className="input" value={siteId} onChange={(e) => setSiteId(e.target.value)} data-testid="ms-site">
            <option value="">{t('matrixSimulate.choose')}</option>
            {siteItems.map((s) => <option key={s.id} value={s.id}>{s.site_code}{s.name ? ` · ${s.name}` : ''}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">{t('matrixSimulate.kind')}
          <select className="input" value={kind} onChange={(e) => { setKind(e.target.value as 'task' | 'register'); setCode(''); }} data-testid="ms-kind">
            <option value="task">{t('matrixSimulate.kind_task')}</option><option value="register">{t('matrixSimulate.kind_register')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">{t('matrixSimulate.what')}
          <select className="input" value={code} onChange={(e) => setCode(e.target.value)} data-testid="ms-code">
            <option value="">{t('matrixSimulate.choose')}</option>
            {kind === 'task'
              ? (tasks.data ?? []).map((x) => <option key={x.code} value={x.code}>{x.code} · {ar && x.name_ar ? x.name_ar : x.name_en}</option>)
              : registers.map((x) => <option key={x.code} value={x.code}>{x.code} · {ar && x.name_ar ? x.name_ar : x.name_en}</option>)}
          </select>
        </label>
        <Link className="link ms-auto" to="/admin/settings/workflow/coverage" data-testid="ms-open-coverage">{t('matrixSimulate.open_coverage')}</Link>
      </div>
      {siteId && code && !d ? <QueryFallback queries={[sim]} testid="ms-loading" /> : null}
      {d ? (
        <div className="space-y-3" data-testid="ms-result">
          <p className="text-sm">{d.site.site_code} · {d.code} · {ar && d.name_ar ? d.name_ar : d.name_en}</p>
          {d.levels.map((l) => (
            <div key={l.level_code} className="rounded border p-3" data-testid={`ms-level-${l.level_code}`}>
              <p className="font-semibold">{l.level_code} <span className="font-normal text-mute">{t(`matrixSimulate.source_${l.source}`)}{l.task_specific ? ` · ${t('matrixSimulate.task_cell')}` : ''}{l.rule ? ` · ${t('matrixSimulate.rule')}: ${l.rule}` : ''}</span></p>
              {l.holders.length > 0 ? (
                <ul className="text-sm" data-testid={`ms-holders-${l.level_code}`}>
                  {l.holders.map((h) => <li key={h.user_id}>{h.name} <span className="text-mute">({h.email}) · {Array.isArray(h.via) ? h.via.join(', ') : h.via}</span></li>)}
                </ul>
              ) : <p className="text-sm text-bad" data-testid={`ms-nobody-${l.level_code}`}>{t('matrixSimulate.nobody')}</p>}
              {l.holders.length === 0 && l.fallback.length > 0 ? (
                <div className="text-sm"><p className="text-mute">{t('matrixSimulate.fallback')}</p>
                  <ul data-testid={`ms-fallback-${l.level_code}`}>{l.fallback.map((h) => <li key={h.user_id}>{h.name} <span className="text-mute">({h.email}) · {Array.isArray(h.via) ? h.via.join(', ') : h.via}</span></li>)}</ul>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
