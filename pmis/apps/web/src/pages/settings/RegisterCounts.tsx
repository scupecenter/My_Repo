import { useTranslation } from 'react-i18next';
import { useRegisterDefs } from '@/api/registers';
import { useRegisterCounts } from '@/api/p4c';
import { QueryFallback } from '@/components/States';

/**
 * Settings > Registers > Register counts (contract 0.15.464, M1). Read only: for every register the records (latest version of each) by state, and the stored
 * versions. It generalises the GECOL / HLC counts (Settings > Data, hidden since this build; the endpoint stays). The screen has no button that changes data.
 */
export function RegisterCounts() {
  const { t, i18n } = useTranslation();
  const q = useRegisterCounts();
  const defs = useRegisterDefs();
  const d = q.data;
  if (!d) return <section className="card p-4" data-testid="page-register-counts"><QueryFallback queries={[q]} testid="rc-loading" /></section>;
  const name = (key: string) => { const x = defs.data?.find((r) => r.register_key === key); return (i18n.language === 'ar' && x?.name_ar) || x?.name_en || key; };
  return (
    <section className="card space-y-3 p-4" data-testid="page-register-counts">
      <h2 className="font-bold">{t('regCounts.title')}</h2>
      <p className="text-sm text-mute">{t('regCounts.note')}</p>
      <p className="text-xs text-mute">{t('regCounts.as_of')}: <bdi>{new Date(d.as_of).toLocaleString()}</bdi></p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-start text-xs text-mute"><th className="p-1 text-start">{t('regCounts.register')}</th><th className="p-1 text-end">{t('regCounts.total')}</th><th className="p-1 text-end">{t('regCounts.versions')}</th><th className="p-1 text-start">{t('regCounts.by_state')}</th></tr></thead>
          <tbody>
            {d.registers.map((r) => (
              <tr key={r.register_key} className="border-t border-line" data-testid={`rc-row-${r.register_key}`}>
                <td className="p-1 font-semibold"><bdi>{name(r.register_key)}</bdi></td>
                <td className="p-1 text-end tabular-nums" data-testid={`rc-total-${r.register_key}`}>{r.total}</td>
                <td className="p-1 text-end tabular-nums">{r.versions}</td>
                <td className="p-1">{r.by_state.length === 0 ? <span className="text-mute">{t('regCounts.empty')}</span> : r.by_state.map((s) => <span key={s.state} className="chip me-1"><bdi>{s.state}</bdi> {s.count}</span>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
