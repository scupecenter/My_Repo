import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useMatrixCoverage } from '@/api/sites';
import { QueryFallback } from '@/components/States';

const TONE: Record<string, string> = { ok: 'text-ok', empty: 'text-bad font-semibold', no_active_holder: 'text-warn font-semibold' };

/**
 * Settings > Workflow > Matrix coverage (contract 0.15.94). Read only: the cells of the Responsibility Matrix that nobody can act on,
 * per row, region and level. Filters: gaps only, region, module. The screen has no button that changes data; the link opens the Matrix.
 */
export function MatrixCoverageScreen() {
  const { t, i18n } = useTranslation();
  const q = useMatrixCoverage();
  const [gapsOnly, setGapsOnly] = useState(true);
  const [region, setRegion] = useState('');
  const [mod, setMod] = useState('');
  const d = q.data;
  if (!d) return <section className="card p-4" data-testid="page-matrix-coverage"><QueryFallback queries={[q]} testid="mc-loading" /></section>;
  const ar = i18n.language.startsWith('ar');
  const modules = [...new Set(d.rows.map((r) => r.module))].sort();
  const regionName = (id: number) => { const r = d.regions.find((x) => x.id === id); return r ? (ar && r.name_ar ? r.name_ar : r.name_en) : String(id); };
  const rows = d.rows.filter((r) => !mod || r.module === mod).map((r) => ({
    ...r, cells: r.cells.filter((c) => (!region || String(c.region_id) === region) && (!gapsOnly || c.status !== 'ok')),
  })).filter((r) => r.cells.length > 0);
  return (
    <section className="card space-y-3 p-4" data-testid="page-matrix-coverage">
      <h2 className="font-bold">{t('matrixCoverage.title')}</h2>
      <p className="text-sm text-mute">{t('matrixCoverage.note')}</p>
      <p className="text-xs text-mute">{t('matrixCoverage.as_of')}: {new Date(d.as_of).toLocaleString()} · {t('matrixCoverage.version')}: {d.workflow_version}</p>
      <p className="text-sm" data-testid="mc-summary">{t('matrixCoverage.summary', { ok: d.summary.ok, empty: d.summary.empty, nobody: d.summary.no_active_holder, cells: d.summary.cells })}</p>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1"><input type="checkbox" checked={gapsOnly} onChange={(e) => setGapsOnly(e.target.checked)} data-testid="mc-gaps-only" />{t('matrixCoverage.gaps_only')}</label>
        <label className="flex items-center gap-1">{t('matrixCoverage.region')}
          <select className="input" value={region} onChange={(e) => setRegion(e.target.value)} data-testid="mc-region"><option value="">{t('matrixCoverage.all')}</option>{d.regions.map((r) => <option key={r.id} value={r.id}>{regionName(r.id)}</option>)}</select>
        </label>
        <label className="flex items-center gap-1">{t('matrixCoverage.module')}
          <select className="input" value={mod} onChange={(e) => setMod(e.target.value)} data-testid="mc-module"><option value="">{t('matrixCoverage.all')}</option>{modules.map((m) => <option key={m} value={m}>{m}</option>)}</select>
        </label>
        <Link className="link ms-auto" to="/admin/matrix" data-testid="mc-open-matrix">{t('matrixCoverage.open_matrix')}</Link>
      </div>
      {rows.length === 0 ? <p className="text-sm text-mute" data-testid="mc-none">{t('matrixCoverage.none')}</p> : (
        <table className="w-full text-sm" data-testid="mc-table">
          <thead><tr className="text-mute"><th className="text-start">{t('matrixCoverage.row')}</th><th className="text-start">{t('matrixCoverage.region')}</th><th className="text-start">L</th><th /><th className="text-end">{t('matrixCoverage.assignees')}</th><th className="text-end">{t('matrixCoverage.holders')}</th><th className="text-start" /></tr></thead>
          <tbody>
            {rows.flatMap((r) => r.cells.map((c) => (
              <tr key={`${r.kind}:${r.code}:${c.region_id}:${c.level_code}`} data-testid={`mc-row-${r.code}-${c.region_id}-${c.level_code}`}>
                <td>{r.code} · {ar && r.name_ar ? r.name_ar : r.name_en}</td><td>{regionName(c.region_id)}</td><td>{c.level_code}</td>
                <td className="text-mute">{t(`matrixCoverage.source_${c.source}`)}</td>
                <td className="text-end tabular-nums">{c.assignees}</td><td className="text-end tabular-nums">{c.holders}</td>
                <td className={TONE[c.status]}>{t(`matrixCoverage.${c.status}`)}</td>
              </tr>
            )))}
          </tbody>
        </table>
      )}
    </section>
  );
}
