import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLinkProposalOps, useLinkProposals } from '@/api/settings';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { errText } from '@/components/FormDialog';

/**
 * Proposed updates from the link triggers (contract 0.15.488, migration 0629). For the entry holders of the target row (and a settings admin): the daily job
 * proposed a new version of an approved record because the record it links to changed. "Make the new version" uses the normal new-version and edit calls as
 * you, so the Matrix and the approval chain apply and the approved version stays in force until the new one is approved. "Dismiss" changes no record.
 */
export function LinkProposals() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useLinkProposals('open');
  const ops = useLinkProposalOps();
  if (!q.data) return <QueryFallback queries={[q]} testid="lp-loading" />;
  const busy = ops.apply.isPending || ops.dismiss.isPending;
  return (
    <section className="space-y-3" data-testid="link-proposals">
      <header>
        <h1 className="text-xl font-semibold">{t('linkProposals.title')}</h1>
        <p className="text-sm text-mute">{t('linkProposals.intro')}</p>
      </header>
      {q.data.length === 0 ? <p className="text-sm text-mute" data-testid="lp-empty">{t('linkProposals.empty')}</p> : (
        <ul className="space-y-2" data-testid="lp-list">
          {q.data.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 rounded border border-line p-3 text-sm" data-testid={`lp-row-${p.id}`}>
              <Link className="font-semibold underline" dir="ltr" to={`/registers/${p.target_register}?record=${p.target_record}`}>{p.target_code ?? p.target_register}</Link>
              <span className="text-mute" dir="ltr">{p.target_field}: {p.before ?? '-'} → <strong>{p.after}</strong></span>
              <span className="ms-auto flex gap-2">
                <button type="button" className="btn btn-accent px-2 py-1 text-xs" disabled={busy} data-testid={`lp-apply-${p.id}`}
                  onClick={() => ops.apply.mutate(p.id, { onError: (e) => toast(errText(e, t), 'err') })}>{t('linkProposals.apply')}</button>
                <button type="button" className="btn px-2 py-1 text-xs" disabled={busy} data-testid={`lp-dismiss-${p.id}`}
                  onClick={() => ops.dismiss.mutate(p.id, { onError: (e) => toast(errText(e, t), 'err') })}>{t('linkProposals.dismiss')}</button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
