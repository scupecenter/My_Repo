import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { useContractorsCompleteness, useTeamScopeMismatch } from '@/api/settings';
import { TeamScopeMatch } from './settings/TeamScopeMatch';

const forbidden = (e: unknown) => e instanceof ApiError && e.status === 403;

/**
 * Reports, contractors and team / scope match (contract 0.12.9, P4b). Procurement sees the running orders that no longer match (Q145) and the match
 * table read-only (Q147); Contractors sees the data to complete (Q142, Q110). A section the caller may not read is left out.
 */
export function ContractorsReports() {
  const { t } = useTranslation();
  const mm = useTeamScopeMismatch(), cc = useContractorsCompleteness();
  return (
    <div className="space-y-4" data-testid="page-contractors-reports">
      <h1 className="text-2xl font-bold">{t('contractorReports.title')}</h1>

      {!forbidden(mm.error) && (
        <section className="card space-y-2 p-4" data-testid="cr-mismatch">
          <h2 className="font-bold">{t('contractorReports.mismatch')}</h2>
          <p className="text-sm text-mute">{t('contractorReports.mismatch_note')}</p>
          {mm.data && !mm.data.items.length && <p className="text-sm" data-testid="cr-mismatch-empty">{t('contractorReports.none')}</p>}
          {!!mm.data?.items.length && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-mute"><tr>
                  <th className="p-2 text-start">{t('contractorReports.site')}</th><th className="p-2 text-start">{t('scopeMatch.scope')}</th>
                  <th className="p-2 text-start">{t('contractorReports.team')}</th><th className="p-2 text-start">{t('contractorReports.party')}</th>
                  <th className="p-2 text-start">{t('contractorReports.problems')}</th><th className="p-2 text-start">{t('contractorReports.action')}</th>
                </tr></thead>
                <tbody>
                  {mm.data.items.map((r) => (
                    <tr key={r.record_id} className="border-t border-line align-top" data-testid={`cr-mismatch-${r.site_code}`}>
                      <td className="p-2"><Link className="mono underline" to={`/registers/procurement?record=${r.record_id}`}>{r.site_code}</Link></td>
                      <td className="p-2">{r.scope ?? '—'}</td>
                      <td className="p-2">{r.team?.name ?? '—'}</td>
                      <td className="p-2">{r.party?.name ?? '—'}</td>
                      <td className="p-2">
                        <ul className="space-y-1">{r.problems.map((p) => (
                          <li key={p.code} data-testid={`cr-problem-${r.site_code}-${p.code}`}>
                            <span className={`chip ${p.severity === 'info' ? 'bg-card2' : 'bg-lateBg text-lateInk'}`}>{t(`contractorReports.code.${p.code}`)}</span>
                            {p.severity === 'info' && <span className="ms-1 text-xs text-mute">{t('contractorReports.info_only')}</span>}
                          </li>))}
                        </ul>
                      </td>
                      <td className="p-2 text-xs">{r.problems.filter((p) => p.severity !== 'info').map((p) => <p key={p.code}>{t(`contractorReports.fix.${p.code}`)}</p>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {!forbidden(cc.error) && (
        <section className="card space-y-2 p-4" data-testid="cr-completeness">
          <h2 className="font-bold">{t('contractorReports.completeness')}</h2>
          <p className="text-sm text-mute">{t('contractorReports.completeness_note')}</p>
          {cc.data && (
            <ul className="space-y-1 text-sm">
              {cc.data.teams.map((x) => <li key={x.team_id} data-testid={`cr-team-${x.name}`}><b>{x.name}</b> ({x.party.name}): {x.issues.map((i) => t(`contractorReports.code.${i}`)).join(', ')}</li>)}
              {cc.data.parties.map((x) => <li key={x.party_id} data-testid={`cr-party-${x.name}`}><b>{x.name}</b>: {x.issues.map((i) => t(`contractorReports.code.${i}`)).join(', ')}</li>)}
              {cc.data.contracts.map((x) => <li key={x.contract_id} data-testid={`cr-contract-${x.contract_ref ?? x.contract_id}`}><b>{x.contract_ref ?? '—'}</b> ({x.party.name}): {x.issues.map((i) => t(`contractorReports.code.${i}`)).join(', ')}</li>)}
              {!cc.data.teams.length && !cc.data.parties.length && !cc.data.contracts.length && <li>{t('contractorReports.none')}</li>}
            </ul>
          )}
        </section>
      )}

      <TeamScopeMatch readOnly />
    </div>
  );
}
