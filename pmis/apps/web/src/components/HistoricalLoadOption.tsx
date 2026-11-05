import { useTranslation } from 'react-i18next';
import type { HistoricalWaiver } from '@/api/historicalWaiver';

export interface HistoricalChoice { on: boolean; reason: string }
export const NO_HISTORICAL: HistoricalChoice = { on: false, reason: '' };
/** The choice is complete when it is off, or on with a reason of at least 3 characters (the contract's minimum). */
export const historicalReady = (c: HistoricalChoice) => !c.on || c.reason.trim().length >= 3;

/**
 * The option "historical load: accept without documents" of a batch screen (Q462, contract 0.14.3). The parent shows it only to a System Admin while the waiver
 * is open (`useHistoricalOffer`); it asks for a reason, and the server asks for the step-up. Rows whose actual date is on or before the cutoff date skip the
 * mandatory-document check; every other check still runs, and each such task is flagged "Admin override".
 */
export function HistoricalLoadOption({ waiver, value, onChange, testid = 'hl' }: { waiver: HistoricalWaiver; value: HistoricalChoice; onChange: (c: HistoricalChoice) => void; testid?: string }) {
  const { t } = useTranslation();
  return (
    <fieldset className="space-y-2 rounded-md border border-line bg-waitBg p-3 text-sm" data-testid={`${testid}-option`}>
      <legend className="px-1 font-semibold text-waitInk">{t('hw.option_title')}</legend>
      <label className="flex items-start gap-2">
        <input type="checkbox" data-testid={`${testid}-toggle`} checked={value.on} onChange={(e) => onChange({ ...value, on: e.target.checked })} />
        <span>
          <span className="font-semibold">{t('hw.option_label')}</span>
          <span className="block text-mute" data-testid={`${testid}-hint`}>{t('hw.option_hint', { cutoff: waiver.cutoff_date ?? '' })}</span>
        </span>
      </label>
      {value.on && (
        <div>
          <label htmlFor={`${testid}-reason`} className="font-semibold">{t('hw.option_reason')}</label>
          <textarea id={`${testid}-reason`} data-testid={`${testid}-reason`} className="input mt-1 min-h-16 w-full" value={value.reason} onChange={(e) => onChange({ ...value, reason: e.target.value })} />
          {value.reason.trim().length < 3 && <p className="mt-1 text-xs text-lateInk" data-testid={`${testid}-reason-needed`}>{t('common.reason_required')}</p>}
        </div>
      )}
    </fieldset>
  );
}
