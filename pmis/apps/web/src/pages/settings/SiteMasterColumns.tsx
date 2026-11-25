import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { SITE_MASTER_MOVABLE_MENUS, useSetSiteMasterColumnSections, useSiteMasterSections } from '@/api/siteMaster';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';

/**
 * Settings > Workflow > Columns (W3, 2026-11-24; before: the SiteMaster tab). Contract 0.15.21, F15: the admin chooses the Site Master menus of each Master column.
 * Unlike the task form of the Workflow Studio, it lists every column in Master order, whatever feeds it (site fields, scope flags, registers, formulas). A column may be in
 * several menus. The status columns are in every menu and cannot change. The change needs a reason and step-up; the API audits it.
 * Global settings live here (Administration > Settings); the grid toolbar keeps only the per-user view items.
 */
export function SiteMasterColumns() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const toast = useToast();
  const sec = useSiteMasterSections();
  const save = useSetSiteMasterColumnSections();
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
    setPick(c.sections.filter((s) => (SITE_MASTER_MOVABLE_MENUS as readonly string[]).includes(s)));
    setEdit({ ord: c.ord, letter: c.letter, header: c.header });
  };
  const toggle = (key: string) => setPick((cur) => (cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key]));

  return (
    <div data-testid="site-master-columns">
      <h2 className="mb-1 text-xl font-bold">{t('siteMasterCols.title')}</h2>
      <p className="mb-1 text-sm text-mute">{t('siteMasterCols.hint')}</p>
      <p className="mb-3 text-sm text-mute" data-testid="siteMasterCols-studio-note">
        {t('siteMasterCols.studio_note')} <Link to="/admin/settings/workflow/editor" className="text-accentText underline" data-testid="siteMasterCols-studio-link">{t('siteMasterCols.studio_link')}</Link>
      </p>
      <div className="card overflow-auto">
        <table className="w-full text-sm" aria-label={t('siteMasterCols.title')}>
          <thead>
            <tr className="text-start text-mute">
              <th className="p-2 text-start">{t('siteMasterCols.col')}</th>
              <th className="p-2 text-start">{t('siteMasterCols.header')}</th>
              <th className="p-2 text-start">{t('siteMasterCols.menus')}</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {columns.map((c) => {
              const fixed = c.sections.includes('status');
              return (
                <tr key={c.ord} className="border-t border-line" data-testid={`siteMasterCols-row-${c.letter}`}>
                  <td className="p-2 font-mono">{c.letter}</td>
                  <td className="p-2">{c.header}</td>
                  <td className="p-2">
                    {fixed ? (
                      <span className="chip" data-testid={`siteMasterCols-fixed-${c.letter}`}>{t('siteMasterCols.status_fixed')}</span>
                    ) : c.sections.length === 0 ? (
                      <span className="text-mute">{t('siteMasterCols.none')}</span>
                    ) : (
                      c.sections.map((s) => <span key={s} className="chip me-1">{name(s)}</span>)
                    )}
                  </td>
                  <td className="p-2 text-end">
                    {fixed ? null : (
                      <button type="button" className="btn btn-ghost" data-testid={`siteMasterCols-edit-${c.letter}`} onClick={() => open(c)}>
                        {t('siteMasterCols.edit')}
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
        testid="siteMasterCols-dialog"
        title={edit ? t('siteMasterCols.reason_title', { column: `${edit.letter} ${edit.header}` }) : ''}
        error={err}
        busy={save.isPending}
        disabled={pick.length === 0}
        onSubmit={(reason) => {
          if (!edit) return;
          setErr(null);
          save.mutate(
            { ord: edit.ord, sections: pick, reason },
            {
              onSuccess: () => { toast(t('siteMasterCols.saved')); setEdit(null); },
              onError: (e) => setErr(errText(e, t)),
            },
          );
        }}
      >
        <fieldset className="space-y-1">
          {SITE_MASTER_MOVABLE_MENUS.map((key) => (
            <label key={key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={pick.includes(key)} onChange={() => toggle(key)} data-testid={`siteMasterCols-menu-${key}`} />
              {name(key)}
            </label>
          ))}
        </fieldset>
      </FormDialog>
    </div>
  );
}
