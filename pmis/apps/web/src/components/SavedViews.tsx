import { Bookmark, Save, Share2, Trash2, UserCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGroups, useRoles } from '@/api/admin';
import type { UserPickerItem } from '@/api/types';
import { importLocalViews, useSavedViewOps, useSavedViews, type LocalView, type SavedView, type SavedViewAudience, type SavedViewColumns, type SavedViewSort } from '@/api/views';
import { loadPref } from '@/lib/localPref';
import type { Prefs } from '@/lib/tablePrefs';
import { errText, FormDialog } from './FormDialog';
import { PeoplePicker } from './PeoplePicker';
import { useToast } from './Toast';

/** The column control of the screen, when it has one (TableKit `useTablePrefs`). */
export type ViewTable = { prefs: Prefs; apply: (c: SavedViewColumns) => void };

/** The browser key of the old local views (before P10); they are imported to the server on first use and then removed. */
export const legacyKey = (screen: string) => `pmis.logviews.${screen}`;

/**
 * Saved views of one list screen (P10, owner answers Q115 and Q117). A view is the screen's filters, its columns (order, hidden, width, density)
 * and its sort, kept on the server per user. The owner may share it with roles, groups, people or everyone when they hold views.share; the server
 * strips columns a reader may not see and never shows another user's private view. Views are versioned and deactivated, never deleted.
 */
export function SavedViews<F>({ screen, value, onApply, empty, table, sort, onSort }: {
  screen: string; value: F; onApply: (f: F) => void; empty: F; table?: ViewTable; sort?: SavedViewSort[]; onSort?: (s: SavedViewSort[]) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useSavedViews(screen);
  const ops = useSavedViewOps(screen);
  const [cur, setCur] = useState('');
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [sharing, setSharing] = useState<SavedView | null>(null);
  const [handing, setHanding] = useState<SavedView | null>(null);
  const imported = useRef(false);
  const items = q.data?.items ?? [];
  const mine = items.filter((v) => v.is_owner), shared = items.filter((v) => !v.is_owner);
  const view = items.find((v) => v.id === cur);
  const fail = (e: unknown) => toast(errText(e, t), 'err');

  // First use: the views this browser kept locally move to the server once (the server skips what it already imported).
  useEffect(() => {
    if (imported.current || !q.isSuccess) return;
    imported.current = true;
    const local = loadPref<unknown>(legacyKey(screen), []);
    if (!Array.isArray(local) || !local.length) return;
    importLocalViews(screen, local as LocalView[]).then((r) => {
      try { localStorage.removeItem(legacyKey(screen)); } catch { /* blocked storage: the server import is idempotent */ }
      if (r.imported) { toast(t('savedViews.imported', { count: r.imported })); void q.refetch(); }
    }, () => { /* keep them locally and try again next time */ });
  }, [q.isSuccess, screen]); // eslint-disable-line react-hooks/exhaustive-deps

  const content = () => ({
    filters: value as unknown as Record<string, unknown>,
    ...(table ? { columns: { order: table.prefs.order, hidden: table.prefs.hidden, width: table.prefs.width, density: table.prefs.density } } : {}),
    ...(sort ? { sort } : {}),
  });
  const apply = (v: SavedView | undefined) => {
    onApply(v ? ({ ...(empty as object), ...v.filters } as F) : empty);
    if (v && table && Object.keys(v.columns ?? {}).length) table.apply(v.columns);
    if (onSort) onSort(v?.sort ?? []);
  };
  const save = () => {
    const n = name.trim();
    if (!n) return;
    ops.create.mutate({ name: n, ...content() }, { onSuccess: (v) => { setCur(v.id); setName(''); setNaming(false); toast(t('savedViews.saved')); }, onError: fail });
  };
  const update = (v: SavedView) => ops.update.mutate({ view: v, patch: content() }, { onSuccess: () => toast(t('savedViews.updated')), onError: fail });

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="saved-views" data-screen={screen}>
      <Bookmark size={14} aria-hidden className="text-mute" />
      <select className="input w-auto" aria-label={t('savedViews.label')} data-testid="views-select" value={cur}
        onChange={(e) => { setCur(e.target.value); apply(items.find((x) => x.id === e.target.value)); }}>
        <option value="">{t('savedViews.default')}</option>
        {!!mine.length && <optgroup label={t('savedViews.mine')}>{mine.map((v) => <option key={v.id} value={v.id}>{v.name}{v.shared ? ` · ${t('savedViews.shared_mark')}` : ''}</option>)}</optgroup>}
        {!!shared.length && <optgroup label={t('savedViews.shared_with_me')}>{shared.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.owner.display_name}</option>)}</optgroup>}
      </select>
      {view?.stripped_columns ? <span className="chip bg-waitBg text-waitInk" data-testid="views-stripped" title={t('savedViews.stripped_hint')}>{t('savedViews.stripped', { count: view.stripped_columns })}</span> : null}
      {view?.owner_left && <span className="chip bg-lateBg text-lateInk" data-testid="views-owner-left">{t('savedViews.owner_left')}</span>}
      {view?.can_edit && <button type="button" className="btn px-2" data-testid="views-update" aria-label={t('savedViews.update')} title={t('savedViews.update')} disabled={ops.update.isPending} onClick={() => update(view)}><Save size={14} aria-hidden /></button>}
      {view?.can_share && <button type="button" className="btn px-2" data-testid="views-share" aria-label={t('savedViews.share')} title={t('savedViews.share')} onClick={() => setSharing(view)}><Share2 size={14} aria-hidden /></button>}
      {view?.can_edit && view.shared && <button type="button" className="btn px-2" data-testid="views-transfer" aria-label={t('savedViews.transfer')} title={t('savedViews.transfer')} onClick={() => setHanding(view)}><UserCheck size={14} aria-hidden /></button>}
      {view?.can_edit && <button type="button" className="btn px-2" data-testid="views-delete" aria-label={t('savedViews.deactivate')} title={t('savedViews.deactivate')}
        onClick={() => ops.deactivate.mutate({ view, reason: view.is_owner ? undefined : t('savedViews.deactivate') }, { onSuccess: () => { setCur(''); toast(t('savedViews.deactivated')); }, onError: fail })}><Trash2 size={14} aria-hidden /></button>}
      {naming
        ? <><input className="input w-40" data-testid="views-name" aria-label={t('savedViews.name')} placeholder={t('savedViews.name')} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
          <button type="button" className="btn btn-accent" data-testid="views-name-ok" disabled={ops.create.isPending} onClick={save}>{t('common.save')}</button></>
        : <button type="button" className="btn" data-testid="views-save" onClick={() => setNaming(true)}>{t('savedViews.save')}</button>}
      {sharing && <ShareDialog view={sharing} scope={q.data?.can_share ?? 'none'} manager={!!q.data?.can_manage} onClose={() => setSharing(null)}
        onSave={(audience, reason) => ops.update.mutate({ view: sharing, patch: { audience, ...(reason ? { reason } : {}) } }, { onSuccess: () => { setSharing(null); toast(t('savedViews.share_saved')); }, onError: fail })} busy={ops.update.isPending} />}
      {handing && <TransferDialog view={handing} onClose={() => setHanding(null)} busy={ops.transfer.isPending}
        onSave={(owner, reason) => ops.transfer.mutate({ view: handing, owner_id: owner, reason }, { onSuccess: () => { setHanding(null); setCur(''); toast(t('savedViews.transferred')); }, onError: fail })} />}
    </div>
  );
}

function ShareDialog({ view, scope, manager, onClose, onSave, busy }: {
  view: SavedView; scope: 'none' | 'limited' | 'all'; manager: boolean; onClose: () => void; onSave: (a: SavedViewAudience, reason: string) => void; busy: boolean;
}) {
  const { t, i18n } = useTranslation();
  const a = view.audience;
  const [everyone, setEveryone] = useState(!!a?.everyone);
  const [people, setPeople] = useState<UserPickerItem[]>((a?.users ?? []).map((u) => ({ id: u.id, display_name: u.display_name, employee_id: u.employee_id ?? null }) as UserPickerItem));
  const [roles, setRoles] = useState<Set<string>>(new Set((a?.roles ?? []).map((r) => r.id)));
  const [groups, setGroups] = useState<Set<string>>(new Set((a?.groups ?? []).map((g) => g.id)));
  const rolesQ = useRoles(), groupsQ = useGroups();
  const flip = (s: Set<string>, id: string) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; };
  const other = !view.is_owner;
  return (
    <FormDialog open onClose={onClose} title={t('savedViews.share_title', { name: view.name })} testid="views-share-dialog" withReason={other} busy={busy} submitLabel={t('savedViews.share_save')}
      onSubmit={(reason) => onSave({ everyone, user_ids: people.map((p) => p.id), role_ids: [...roles], group_ids: [...groups] }, reason)}>
      <p className="text-sm text-mute">{t('savedViews.share_hint')}</p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" data-testid="views-share-everyone" checked={everyone} disabled={scope !== 'all' && !manager} onChange={(e) => setEveryone(e.target.checked)} />
        {t('savedViews.everyone')}
      </label>
      {scope !== 'all' && !manager && <p className="text-xs text-mute" data-testid="views-share-limited">{t('savedViews.limited_hint')}</p>}
      <div><div className="mb-1 text-sm font-semibold">{t('savedViews.people')}</div><PeoplePicker id="views-share-people" value={people} onChange={setPeople} /></div>
      {rolesQ.isSuccess && !!rolesQ.data.length && (
        <fieldset className="max-h-32 overflow-y-auto text-sm" data-testid="views-share-roles"><legend className="font-semibold">{t('savedViews.roles')}</legend>
          {rolesQ.data.filter((r) => r.is_active).map((r) => <label key={r.id} className="flex items-center gap-2"><input type="checkbox" checked={roles.has(r.id)} onChange={() => setRoles((s) => flip(s, r.id))} />{(i18n.language === 'ar' && r.name_ar) || r.name_en}</label>)}
        </fieldset>
      )}
      {groupsQ.isSuccess && !!groupsQ.data.length && (
        <fieldset className="max-h-32 overflow-y-auto text-sm" data-testid="views-share-groups"><legend className="font-semibold">{t('savedViews.groups')}</legend>
          {groupsQ.data.map((g) => <label key={g.id} className="flex items-center gap-2"><input type="checkbox" checked={groups.has(g.id)} onChange={() => setGroups((s) => flip(s, g.id))} />{g.name}</label>)}
        </fieldset>
      )}
    </FormDialog>
  );
}

function TransferDialog({ view, onClose, onSave, busy }: { view: SavedView; onClose: () => void; onSave: (owner: string, reason: string) => void; busy: boolean }) {
  const { t } = useTranslation();
  const [to, setTo] = useState<UserPickerItem[]>([]);
  return (
    <FormDialog open onClose={onClose} title={t('savedViews.transfer_title', { name: view.name })} testid="views-transfer-dialog" busy={busy} disabled={!to.length} submitLabel={t('savedViews.transfer')}
      onSubmit={(reason) => to[0] && onSave(to[0].id, reason)}>
      <p className="text-sm text-mute">{t('savedViews.transfer_hint')}</p>
      <PeoplePicker id="views-transfer-to" single value={to} onChange={setTo} />
    </FormDialog>
  );
}
