import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { downloadTemplate, useTemplates } from '@/api/registers';
import type { Template } from '@/api/types';
import { ICONS, ICON_PROPS } from '@/lib/icons';
import { registerErrorMessage } from '@/lib/registerErrors';
import { Combobox, type ComboOption } from './Combobox';
import { useToast } from './Toast';
import { TemplateUploadDialog } from './TemplateUploadDialog';

const ownScreen = (x: Template) => x.template_kind === 'list_values' || x.template_kind === 'holidays' || x.template_kind === 'daily_plan';
export type QuickAction = 'blank' | 'prefill' | 'upload' | 'open';

/**
 * The quick download bar (Data hub): two cascading dropdowns, the template first, then the action that template allows (blank copy, pre-filled copy, upload,
 * open its page). It complements the cards; it never replaces them. A download goes through the same call as the card button, so it lands in the audit and in
 * "your last downloads".
 */
export function TemplateQuickBar({ testid = 'quickbar' }: { testid?: string }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const nav = useNavigate();
  const qc = useQueryClient();
  const templates = useTemplates();
  const [tplId, setTplId] = useState('');
  const [action, setAction] = useState<QuickAction | ''>('');
  const [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState<Template | null>(null);
  const nameOf = (x: { name_en: string; name_ar?: string | null }) => (i18n.language === 'ar' && x.name_ar) || x.name_en;
  const list = useMemo(() => (templates.data ?? []).filter((x) => x.template_id && x.is_active && (x.register_key || x.stream || x.template_kind)), [templates.data]);
  const tpl = list.find((x) => x.template_id === tplId);
  const tplOptions: ComboOption[] = list.map((x) => ({ id: x.template_id, label: nameOf(x), hint: t(`dhub.kind_${x.template_kind ?? (x.stream ? 'stream' : 'register')}`) + ` · v${x.current_version}`, search: x.name_en }));
  const actions: ComboOption[] = tpl ? [
    { id: 'blank', label: t('dhub.act_blank'), hint: t('dhub.act_blank_hint') },
    ...(tpl.register_key || tpl.stream ? [{ id: 'prefill', label: t('dhub.act_prefill'), hint: t('dhub.act_prefill_hint') }] : []),
    ...(ownScreen(tpl) ? [] : [{ id: 'upload', label: t('dhub.act_upload'), hint: t('dhub.act_upload_hint') }]),
    { id: 'open', label: t('dhub.act_open'), hint: t('dhub.act_open_hint') },
  ] : [];
  const go = async () => {
    if (!tpl || !action) return;
    if (action === 'upload') { setUpload(tpl); return; }
    if (action === 'open') { nav('/templates'); return; }
    setBusy(true);
    try {
      const n = await downloadTemplate(tpl.template_id, { prefill: action === 'prefill' });
      toast(t('grid.downloaded', { name: n }));
      void qc.invalidateQueries({ queryKey: ['data-hub'] });
    } catch (e) { toast(registerErrorMessage(t, e), 'err'); } finally { setBusy(false); }
  };
  const Go = ICONS[action === 'upload' ? 'upload' : action === 'open' ? 'template' : 'downloadFile'];
  return (
    <div className="flex flex-wrap items-end gap-2" data-testid={testid} role="group" aria-label={t('dhub.quick_title')}>
      <label className="min-w-56 flex-1 text-xs text-mute">{t('dhub.pick_template')}
        <Combobox testid={`${testid}-template`} label={t('dhub.pick_template')} placeholder={t('dhub.pick_template_ph')} value={tplId} options={tplOptions} emptyText={t('dhub.none_found')}
          onChange={(id) => { setTplId(id); setAction(''); }} />
      </label>
      <label className="min-w-48 flex-1 text-xs text-mute">{t('dhub.pick_action')}
        <Combobox testid={`${testid}-action`} label={t('dhub.pick_action')} placeholder={tpl ? t('dhub.pick_action_ph') : t('dhub.pick_template_first')} value={action} options={actions} emptyText={t('dhub.pick_template_first')}
          onChange={(id) => setAction(id as QuickAction)} />
      </label>
      <button type="button" className="btn btn-primary px-3 py-1.5" disabled={!tpl || !action || busy} onClick={() => void go()} data-testid={`${testid}-go`} title={t('dhub.quick_go')} aria-label={t('dhub.quick_go')}>
        <Go {...ICON_PROPS} size={16} />
        <span>{t('dhub.quick_go')}</span>
      </button>
      {upload && <TemplateUploadDialog open onClose={() => setUpload(null)} templateId={upload.template_id} templateName={nameOf(upload)} kind={upload.stream ? 'stream' : upload.template_kind === 'master' ? 'master' : upload.template_kind === 'sites' ? 'sites' : 'register'} onDone={() => qc.invalidateQueries({ queryKey: ['data-hub'] })} />}
    </div>
  );
}
