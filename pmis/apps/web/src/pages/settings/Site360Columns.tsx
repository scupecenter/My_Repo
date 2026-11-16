import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SITE360_MOVABLE_MENUS, useSetSite360ColumnSections, useSite360Sections } from '@/api/site360';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';

/**
 * Settings, SITE 360 columns (contract 0.15.21, F15): the admin chooses the SITE 360 menus of each Master column. A column may be in
 * several menus. The status columns are in every menu and cannot change. The change needs a reason and step-up; the API audits it.
 * Global settings live here (Administration > Settings); the grid toolbar keeps only the per-user view items.
 */
export function Site360Columns() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const toast = useToast();
  const sec = useSite360Sections();
  const save = useSetSite360ColumnSections();
  const [edit, setEdit] = useState<{ ord: number; letter: string; header: string } | null>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const menus = sec.data?.items ?? [];
  const name = (key: string) => {
    const m = menus.find((x) => x.key === key);
    return m ? (lang === 'ar' ? m.name_ar : m.name_en) : key;
  };
  // The Master menu lists every column of the sheet, in Master order.
  const columns = menus.find((m) => m.key === 'master')?.columns ?? [];

  const open = (c: { ord: number; letter: string; header: string; sections: string[] }) => {
    setErr(null);
    setPick(c.sections.filter((s) => (SITE360_MOVABLE_MENUS as readonly string[]).includes(s)));
    setEdit({ ord: c.ord, letter: c.letter, header: c.header });
  };
  const toggle = (key: string) => setPick((cur) => (cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key]));

  return (
    <div data-testid="site360-columns">
      <p className="mb-3 text-sm text-mute">{t('site360cols.hint')}</p>
      <div className="card overflow-auto">
        <table className="w-full text-sm" aria-label={t('site360cols.title')}>
          <thead>
            <tr className="text-start text-mute">
              <th className="p-2 text-start">{t('site360cols.col')}</th>
              <th className="p-2 text-start">{t('site360cols.header')}</th>
              <th className="p-2 text-start">{t('site360cols.menus')}</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {columns.map((c) => {
              const fixed = c.sections.includes('status');
              return (
                <tr key={c.ord} className="border-t border-line" data-testid={`site360cols-row-${c.letter}`}>
                  <td className="p-2 font-mono">{c.letter}</td>
                  <td className="p-2">{c.header}</td>
                  <td className="p-2">
                    {fixed ? (
                      <span className="chip" data-testid={`site360cols-fixed-${c.letter}`}>{t('site360cols.status_fixed')}</span>
                    ) : c.sections.length === 0 ? (
                      <span className="text-mute">{t('site360cols.none')}</span>
                    ) : (
                      c.sections.map((s) => <span key={s} className="chip me-1">{name(s)}</span>)
                    )}
                  </td>
                  <td className="p-2 text-end">
                    {fixed ? null : (
                      <button type="button" className="btn btn-ghost" data-testid={`site360cols-edit-${c.letter}`} onClick={() => open(c)}>
                        {t('site360cols.edit')}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <FormDialog
        open={edit !== null}
        onClose={() => setEdit(null)}
        testid="site360cols-dialog"
        title={edit ? t('site360cols.reason_title', { column: `${edit.letter} ${edit.header}` }) : ''}
        error={err}
        busy={save.isPending}
        disabled={pick.length === 0}
        onSubmit={(reason) => {
          if (!edit) return;
          setErr(null);
          save.mutate(
            { ord: edit.ord, sections: pick, reason },
            {
              onSuccess: () => { toast(t('site360cols.saved')); setEdit(null); },
              onError: (e) => setErr(errText(e, t)),
            },
          );
        }}
      >
        <fieldset className="space-y-1">
          {SITE360_MOVABLE_MENUS.map((key) => (
            <label key={key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={pick.includes(key)} onChange={() => toggle(key)} data-testid={`site360cols-menu-${key}`} />
              {name(key)}
            </label>
          ))}
        </fieldset>
      </FormDialog>
    </div>
  );
}
