import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/api/hooks';
import { UI_FEATURES_SEED, useSaveUiFeatures, useUiFeaturesSetting, type UiFeatures } from '@/api/uiFeatures';
import { Avatar } from '@/components/Avatar';
import { errText, FormDialog } from '@/components/FormDialog';
import { canEditDisplayDefaults } from '@/components/TableStandard';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { INBOX_TABS } from '@/lib/inboxPriority';
import { FieldErr } from './Calendar';

const INBOX_KINDS = ['mention', 'followed_change', 'task_assigned', 'task_returned', 'task_rejected', 'task_approved', 'approval_due', 'reassigned', 'absence_alert', 'idle_task_alert', 'no_holder', 'system'] as const;

const SAMPLE = ['Demo Person A', 'سالم المصراتي', 'Demo Person B', 'خالد الزاوي', 'Demo CW Team'];

/**
 * Administration > Settings > Screens > Interface (migration 0280): the interface features in one place. Now: generated avatars (style, shape, palette, in lists)
 * and the "New" badge (on or off, how many days). Later features add their own section here. Saved by a System Admin or an all-regions delegate of
 * admin.settings, with a reason, If-Match and an audit row (before and after). The preview draws the choice before it is saved.
 */
export function InterfaceSettings() {
  const { t } = useTranslation();
  const toast = useToast();
  const me = useMe(true).data;
  const q = useUiFeaturesSetting(), save = useSaveUiFeatures();
  const [f, setF] = useState<UiFeatures | null>(null);
  const [open, setOpen] = useState(false);
  const can = canEditDisplayDefaults(me);
  const errs = fieldErrors(save.error);
  if (q.isError) return <p role="alert" className="card p-4 text-lateInk" data-testid="ui-settings-error">{errText(q.error, t)}</p>;
  if (!q.data) return <p className="text-mute">{t('common.loading')}</p>;
  const v: UiFeatures = f ?? { ...UI_FEATURES_SEED, ...q.data.sections };
  const set = <K extends keyof UiFeatures>(k: K, patch: Partial<UiFeatures[K]>) => setF({ ...v, [k]: { ...v[k], ...patch } });
  const radio = <T extends string>(name: string, values: readonly T[], cur: T, on: (x: T) => void) => (
    <fieldset className="space-y-1" disabled={!can}>
      <legend className="text-sm font-semibold">{t(`ui.av_${name}`)}</legend>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t(`ui.av_${name}`)}>
        {values.map((x) => <button key={x} type="button" role="radio" aria-checked={cur === x} data-testid={`ui-av-${name}-${x}`} onClick={() => on(x)} className={`btn px-2 py-1 text-xs ${cur === x ? 'bg-accentSoft text-accentText' : ''}`}>{t(`ui.av_${name}_${x}`)}</button>)}
      </div>
      <FieldErr errs={errs} path={`/sections/avatars/${name}`} />
    </fieldset>
  );
  return (
    <div className="space-y-4" data-testid="page-ui-settings">
      <section className="card space-y-4 p-4">
        <div>
          <h2 className="font-bold">{t('ui.avatars_title')}</h2>
          <p className="text-sm text-mute">{t('ui.avatars_note')}</p>
        </div>
        {radio('style', ['gradient', 'geometric', 'initials', 'none'] as const, v.avatars.style, (x) => set('avatars', { style: x }))}
        {radio('shape', ['circle', 'rounded'] as const, v.avatars.shape, (x) => set('avatars', { shape: x }))}
        {radio('palette', ['varied', 'brand'] as const, v.avatars.palette, (x) => set('avatars', { palette: x }))}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!can} data-testid="ui-av-in-lists" checked={v.avatars.in_lists} onChange={(e) => set('avatars', { in_lists: e.target.checked })} />{t('ui.av_in_lists')}</label>
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-line p-3" data-testid="ui-av-preview" aria-label={t('ui.preview')}>
          {SAMPLE.map((n) => (
            <span key={n} className="inline-flex items-center gap-2 text-sm">
              <Avatar name={n} size="md" config={v.avatars} />{n}
            </span>
          ))}
        </div>
      </section>
      <section className="card space-y-3 p-4">
        <div>
          <h2 className="font-bold">{t('ui.new_title')}</h2>
          <p className="text-sm text-mute">{t('ui.new_note')}</p>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!can} data-testid="ui-new-enabled" checked={v.new_badge.enabled} onChange={(e) => set('new_badge', { enabled: e.target.checked })} />{t('ui.new_enabled')}</label>
        <label className="block text-sm font-semibold">{t('ui.new_days')}
          <input type="number" min={1} max={90} disabled={!can || !v.new_badge.enabled} className="input mt-1 w-28 font-normal" data-testid="ui-new-days" value={v.new_badge.days}
            onChange={(e) => set('new_badge', { days: e.target.value === '' ? 0 : Number(e.target.value) })} />
          <span className="block text-xs font-normal text-mute">{t('rules.range', { min: 1, max: 90 })}</span>
          <FieldErr errs={errs} path="/sections/new_badge/days" />
        </label>
        <p className="flex items-center gap-2 text-sm" data-testid="ui-new-preview"><span className="chip bg-accentSoft px-1.5 py-0 text-[10px] uppercase tracking-wide text-accentText">{t('ui.new')}</span><span className="text-mute">{t('ui.new_preview')}</span></p>
      </section>
      <section className="card space-y-3 p-4" data-testid="ui-inbox">
        <div>
          <h2 className="font-bold">{t('ui.inbox_title')}</h2>
          <p className="text-sm text-mute">{t('ui.inbox_note')}</p>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!can} data-testid="ui-inbox-tabs" checked={v.inbox.tabs_enabled} onChange={(e) => set('inbox', { tabs_enabled: e.target.checked })} />{t('ui.inbox_tabs')}</label>
        <label className="block text-sm font-semibold">{t('ui.inbox_default_tab')}
          <select className="input mt-1 w-auto font-normal" disabled={!can || !v.inbox.tabs_enabled} data-testid="ui-inbox-default" value={v.inbox.default_tab} onChange={(e) => set('inbox', { default_tab: e.target.value as UiFeatures['inbox']['default_tab'] })}>
            {INBOX_TABS.map((x) => <option key={x} value={x}>{t(`inbox.tab_${x}`)}</option>)}
          </select>
          <FieldErr errs={errs} path="/sections/inbox/default_tab" />
        </label>
        <fieldset className="space-y-1" disabled={!can}>
          <legend className="text-sm font-semibold">{t('ui.inbox_priority_kinds')}</legend>
          <p className="text-xs text-mute">{t('ui.inbox_priority_note')}</p>
          <div className="grid gap-1 sm:grid-cols-2">
            {INBOX_KINDS.map((k) => (
              <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid={`ui-inbox-kind-${k}`} checked={v.inbox.priority_kinds.includes(k)}
                onChange={(e) => set('inbox', { priority_kinds: e.target.checked ? [...v.inbox.priority_kinds, k] : v.inbox.priority_kinds.filter((x) => x !== k) })} />{t(`inbox.kind_${k}`)}</label>
            ))}
          </div>
          <FieldErr errs={errs} path="/sections/inbox/priority_kinds" />
        </fieldset>
      </section>
      <section className="card space-y-3 p-4" data-testid="ui-panel">
        <div>
          <h2 className="font-bold">{t('ui.panel_title')}</h2>
          <p className="text-sm text-mute">{t('ui.panel_note')}</p>
        </div>
        <label className="block text-sm font-semibold">{t('ui.panel_mode')}
          <select className="input mt-1 w-auto font-normal" disabled={!can} data-testid="ui-panel-mode" value={v.panel.mode} onChange={(e) => set('panel', { mode: e.target.value as UiFeatures['panel']['mode'] })}>
            {(['popover', 'side_panel'] as const).map((x) => <option key={x} value={x}>{t(`ui.panel_mode_${x}`)}</option>)}
          </select>
          <FieldErr errs={errs} path="/sections/panel/mode" />
        </label>
        <label className="block text-sm font-semibold">{t('ui.panel_width')}
          <select className="input mt-1 w-auto font-normal" disabled={!can || v.panel.mode !== 'side_panel'} data-testid="ui-panel-width" value={v.panel.width} onChange={(e) => set('panel', { width: e.target.value as UiFeatures['panel']['width'] })}>
            {(['narrow', 'medium', 'wide'] as const).map((x) => <option key={x} value={x}>{t(`ui.panel_width_${x}`)}</option>)}
          </select>
          <FieldErr errs={errs} path="/sections/panel/width" />
        </label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!can || v.panel.mode !== 'side_panel'} data-testid="ui-panel-tabs" checked={v.panel.show_tabs} onChange={(e) => set('panel', { show_tabs: e.target.checked })} />{t('ui.panel_tabs')}</label>
      </section>
      {q.data.updated_by && <p className="text-xs text-mute" data-testid="ui-updated">{t('tstd.settings_updated', { name: q.data.updated_by.display_name, at: q.data.updated_at ?? '' })}</p>}
      {can ? (
        <div className="flex gap-2">
          <button type="button" className="btn btn-accent" data-testid="ui-save" disabled={!f} onClick={() => setOpen(true)}>{t('common.save')}</button>
          <button type="button" className="btn" data-testid="ui-discard" disabled={!f} onClick={() => setF(null)}>{t('common.cancel')}</button>
        </div>
      ) : <p className="text-sm text-mute" data-testid="ui-read-only">{t('tstd.settings_read_only')}</p>}
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="ui-dialog" title={t('ui.settings_title')} busy={save.isPending} error={save.isError && !Object.keys(errs).length ? errText(save.error, t) : null}
          onSubmit={(reason) => save.mutate({ sections: v, reason, version: q.data.version }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setF(null); } })} />
      )}
    </div>
  );
}
