import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/api/client';

export function EmployeeId() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [v, setV] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^[0-9]{4}$/.test(v)) return setErr(t('employeeId.invalid'));
    try {
      await api.post('/auth/employee-id', { body: { employee_id: v } });
      await qc.invalidateQueries({ queryKey: ['session'] });
    } catch (x) {
      const code = x instanceof ApiError ? (x.problem.errors?.[0]?.code ?? x.code) : '';
      setErr(code === 'not_in_registry' ? t('employeeId.not_in_registry') : code === 'duplicate' ? t('employeeId.duplicate') : t('errors.generic'));
    }
  };
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <form onSubmit={(e) => void submit(e)} className="card w-[min(420px,100%)] space-y-3 p-6" data-testid="employee-id-form">
        <h1 className="text-xl font-bold">{t('employeeId.title')}</h1>
        <p className="text-mute">{t('employeeId.body')}</p>
        <label htmlFor="eid" className="block text-sm font-semibold">{t('employeeId.label')}</label>
        <input id="eid" data-testid="employee-id-input" className="input mono" dir="ltr" inputMode="numeric" maxLength={4} value={v} onChange={(e) => { setV(e.target.value); setErr(''); }} />
        {err && <p role="alert" data-testid="employee-id-error" className="text-lateInk">{err}</p>}
        <button className="btn btn-accent w-full" data-testid="employee-id-submit">{t('employeeId.submit')}</button>
      </form>
    </div>
  );
}
