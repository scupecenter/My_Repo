import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Settings, edit in place: the same contract as FormDialog (same testids `<testid>-reason`, `-reason-error`, `-error`, `-submit`, same mandatory reason of
 * 3 characters, `onSubmit` gets the trimmed reason) but the form is part of the page, where the row or the section is, not a modal. The save path, the
 * version check and the audit are the caller's and do not change.
 */
export function InlinePanel({ onClose, title, testid, children, onSubmit, submitLabel, busy, error, disabled, withReason = true, as: Tag = 'div' }: {
  onClose: () => void; title: string; testid: string; children?: ReactNode; onSubmit: (reason: string) => void; submitLabel?: string; busy?: boolean;
  error?: string | null; disabled?: boolean; withReason?: boolean; as?: 'div' | 'section';
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const short = withReason && reason.trim().length < 3;
  return (
    <Tag data-testid={testid} role="group" aria-label={title} className="space-y-3 rounded-md border border-line bg-card2 p-4"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <h3 className="font-bold">{title}</h3>
      {children}
      {withReason && (
        <div>
          <label htmlFor={`${testid}-reason`} className="text-sm font-semibold">{t('common.reason')}</label>
          <textarea id={`${testid}-reason`} data-testid={`${testid}-reason`} className="input mt-1 min-h-16" value={reason} onChange={(e) => setReason(e.target.value)} onBlur={() => setTouched(true)} />
          {touched && short && <p role="alert" data-testid={`${testid}-reason-error`} className="mt-1 text-sm text-lateInk">{t('common.reason_required')}</p>}
        </div>
      )}
      {error && <p role="alert" data-testid={`${testid}-error`} className="text-lateInk">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-accent" data-testid={`${testid}-submit`} disabled={busy || disabled} onClick={() => (short ? setTouched(true) : onSubmit(reason.trim()))}>{submitLabel ?? t('common.save')}</button>
      </div>
    </Tag>
  );
}
