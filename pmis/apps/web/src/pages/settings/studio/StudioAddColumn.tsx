import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useListCatalogues } from '@/api/lists';
import { COLUMN_TYPES, TASK_INPUT_KEYS, useColumnAdmin, useSiteCustomFields, type ColumnCreate, type ColumnType, type MenuKey } from '@/api/site360Columns';
import { useToast } from '@/components/Toast';
import type { Ctx } from './studioCtx';
import { colCb, useColErr } from './colErr';
import { MenuPicker } from './StudioColumns';
import { StudioCard } from './StudioForms';
import type { StudioSel } from './studioModel';
import { nextColumnLetter } from './studioModel';

const lbl = 'block text-sm font-semibold';
const field = 'input mt-1 min-h-11 font-normal';
const CUSTOM_KEY = /^[a-z0-9_]{1,60}$/;

/**
 * The add screen, tab "New Site Master column": the place (after which column, band and group), the names, the type, the dropdown list, where the values come
 * from (an input of a workflow task, or a site custom field) and the menus. Nothing is written until "Add column", which asks for the reason like every write.
 */
export function AddColumn({ c, presetTask, onClose, onAdded }: { c: Ctx; presetTask?: string; onClose: () => void; onAdded: (s: StudioSel) => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const fmt = useColErr();
  const ar = i18n.language === 'ar';
  const q = useColumnAdmin();
  const lists = (useListCatalogues().data ?? []).filter((l) => l.is_active);
  const fields = (useSiteCustomFields().data ?? []).filter((f) => f.is_active !== false && !f.master_export_column);
  const items = q.data?.items ?? [];
  const bands = q.data?.bands ?? [];
  const tasks = c.placements.filter((p) => p.is_active !== false);

  const mineOfTask = (code: string) => items.filter((x) => x.source.kind === 'task' && x.source.task_code === code);
  const dflt = (() => {
    const last = [...mineOfTask(presetTask ?? '')].sort((a, b) => a.display_order - b.display_order).pop();
    return last ?? [...items].filter((x) => x.is_active && x.group_top !== 'STATUS' && x.group_top !== 'Phase Gate').sort((a, b) => a.display_order - b.display_order).pop();
  })();
  const [afterPick, setAfterPick] = useState<number | null>(null);
  const afterOrd = afterPick ?? dflt?.ord ?? 0;
  const afterCol = items.find((x) => x.ord === afterOrd);
  const [bandPick, setBandPick] = useState<string | null>(null);
  const [groupPick, setGroupPick] = useState<string | null>(null);
  const band = bandPick ?? afterCol?.group_top ?? '';
  const group = groupPick ?? afterCol?.group_mid ?? '';
  const groupsOfBand = bands.find((b) => b.name === band)?.groups.filter((g): g is string => !!g) ?? [];
  const [en, setEn] = useState('');
  const [arName, setArName] = useState('');
  const [type, setType] = useState<ColumnType>('text');
  const [list, setList] = useState('');
  const [src, setSrc] = useState<'task' | 'field'>('task');
  const [task, setTask] = useState(presetTask && tasks.some((p) => p.task_code === presetTask) ? presetTask : tasks[0]?.task_code ?? '');
  const [key, setKey] = useState('');
  const [custom, setCustom] = useState('');
  const [fieldId, setFieldId] = useState('');
  const [menus, setMenus] = useState<MenuKey[]>([]);
  const nm = (x: { name_en?: string; name_ar?: string | null }) => (ar && x.name_ar ? x.name_ar : x.name_en ?? '');

  const letter = nextColumnLetter(items);
  const keyOk = key !== '__custom' || CUSTOM_KEY.test(custom);
  const valid = !!afterCol && !!en.trim() && !!band.trim() && (type !== 'list' || !!list) && (src === 'task' ? !!task && keyOk : !!fieldId);
  const body = (reason: string): ColumnCreate => ({
    name_en: en.trim(), ...(arName.trim() ? { name_ar: arName.trim() } : {}), group_top: band.trim(), group_mid: group.trim() || null, after_ord: afterOrd, value_type: type, ...(type === 'list' ? { list_catalogue: list } : {}),
    source: src === 'task' ? { kind: 'task_input', task_code: task, ...(key === '__custom' ? { field_key: `v:${custom}` } : key ? { field_key: key } : {}) } : { kind: 'site_field', field_id: fieldId },
    ...(menus.length ? { sections: menus } : {}), reason,
  });
  const submit = () => c.askReason({
    title: t('studio.columns.add'), hint: t('studio.columns.letter_preview', { letter }),
    run: (reason, cb) => c.W.colCreate.mutate(body(reason), { ...colCb(cb, fmt), onSuccess: (r) => { cb.onSuccess(); toast(t('studio.columns.saved_added', { letter: r.letter })); if (src === 'task') onAdded({ kind: 'task', code: task }); else onClose(); } }),
  });

  return (
    <div className="space-y-4" data-testid="studio-add-column">
      {q.isError && <p role="alert" className="text-sm text-lateInk" data-testid="studio-add-column-error">{t('studio.columns.no_access')}</p>}
      <StudioCard title={`1. ${t('studio.columns.step_place')}`} testid="studio-step-col-place">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={`${lbl} sm:col-span-2`}>{t('studio.columns.after')}
            <select className={field} data-testid="studio-add-col-after" value={afterOrd} onChange={(e) => { setAfterPick(Number(e.target.value)); setBandPick(null); setGroupPick(null); }}>
              {items.filter((x) => x.is_active).map((x) => <option key={x.ord} value={x.ord}>{x.letter} {x.header}</option>)}</select></label>
          <label className={lbl}>{t('studio.columns.band')}
            <input className={field} list="studio-col-bands" data-testid="studio-add-col-band" value={band} onChange={(e) => { setBandPick(e.target.value); setGroupPick(''); }} />
            <datalist id="studio-col-bands">{bands.filter((b) => b.name).map((b) => <option key={b.name} value={b.name ?? ''} />)}</datalist></label>
          <label className={lbl}>{t('studio.columns.group')}
            <input className={field} list="studio-col-groups" data-testid="studio-add-col-group" value={group} placeholder={t('studio.columns.group_none')} onChange={(e) => setGroupPick(e.target.value)} />
            <datalist id="studio-col-groups">{groupsOfBand.map((g) => <option key={g} value={g} />)}</datalist></label>
        </div>
        <p className="text-xs text-mute">{t('studio.columns.place_hint')}</p>
        <p className="text-sm font-semibold" data-testid="studio-add-col-letter" aria-live="polite">{t('studio.columns.letter_preview', { letter })}</p>
      </StudioCard>

      <StudioCard title={`2. ${t('studio.columns.step_what')}`} testid="studio-step-col-what">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={lbl}>{t('wfe.name_en')}<input className={field} dir="ltr" data-testid="studio-add-col-en" value={en} onChange={(e) => setEn(e.target.value)} /></label>
          <label className={lbl}>{t('wfe.name_ar')}<input className={field} dir="rtl" data-testid="studio-add-col-ar" value={arName} onChange={(e) => setArName(e.target.value)} /></label>
          <label className={lbl}>{t('studio.columns.type')}
            <select className={field} data-testid="studio-add-col-type" value={type} onChange={(e) => setType(e.target.value as ColumnType)}>{COLUMN_TYPES.map((x) => <option key={x} value={x}>{t(`studio.columns.type_${x}`)}</option>)}</select></label>
          {type === 'list' && (
            <label className={lbl}>{t('studio.columns.list_for')}
              <select className={field} data-testid="studio-add-col-list" value={list} onChange={(e) => setList(e.target.value)}>
                <option value="">{t('studio.columns.pick_list')}</option>{lists.map((l) => <option key={l.code} value={l.code}>{nm(l)} ({l.code})</option>)}</select></label>
          )}
        </div>
        <p className="text-xs text-mute">{t('studio.columns.type_follows')}</p>
      </StudioCard>

      <StudioCard title={`3. ${t('studio.columns.step_source')}`} testid="studio-step-col-source">
        <div role="radiogroup" aria-label={t('studio.columns.step_source')} className="flex flex-wrap gap-4">
          {(['task', 'field'] as const).map((k) => <label key={k} className="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name="studio-col-src" className="h-5 w-5" data-testid={`studio-add-col-src-${k}`} checked={src === k} onChange={() => setSrc(k)} />{t(`studio.columns.src_${k}`)}</label>)}
        </div>
        {src === 'task' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={lbl}>{t('studio.columns.task')}
              <select className={field} data-testid="studio-add-col-task" value={task} onChange={(e) => setTask(e.target.value)}>{tasks.map((p) => <option key={p.task_code} value={p.task_code}>{p.task_code} {nm(p)}</option>)}</select></label>
            <label className={lbl}>{t('studio.columns.input_key')}
              <select className={field} data-testid="studio-add-col-key" value={key} onChange={(e) => setKey(e.target.value)}>
                <option value="">{t('studio.columns.key_new')}</option>
                {TASK_INPUT_KEYS.map((k) => <option key={k} value={k}>{t(`studio.columns.key_${k}`)}</option>)}
                <option value="__custom">{t('studio.columns.key_custom')}</option></select></label>
            {key === '__custom' && <label className={lbl}>{t('studio.columns.custom_key')}<input className={field} dir="ltr" data-testid="studio-add-col-custom" value={custom} aria-invalid={!keyOk} onChange={(e) => setCustom(e.target.value.toLowerCase())} /></label>}
          </div>
        ) : fields.length === 0 ? <p className="text-sm text-mute" data-testid="studio-add-col-nofields">{t('studio.columns.no_fields')}</p> : (
          <label className={lbl}>{t('studio.columns.site_field')}
            <select className={field} data-testid="studio-add-col-field" value={fieldId} onChange={(e) => setFieldId(e.target.value)}>
              <option value="">{t('studio.columns.pick_field')}</option>{fields.map((f) => <option key={f.id} value={f.id}>{nm({ name_en: f.label_en, name_ar: f.label_ar })} ({f.code})</option>)}</select></label>
        )}
      </StudioCard>

      <StudioCard title={`4. ${t('studio.columns.step_menus')}`} testid="studio-step-col-menus">
        <p className="text-sm text-mute">{t('studio.columns.menus_default')}</p>
        <MenuPicker value={menus} onChange={setMenus} prefix="studio-add-col-menu" />
      </StudioCard>

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn min-h-11" data-testid="studio-add-cancel" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-accent min-h-11" data-testid="studio-add-submit" disabled={!valid || !c.canCols} title={!c.canCols ? t('studio.columns.readonly') : undefined} onClick={submit}>{t('studio.columns.add')}</button>
      </div>
    </div>
  );
}
