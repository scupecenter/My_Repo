import {
  closestCenter, DndContext, MouseSensor, pointerWithin, TouchSensor, useDroppable, useSensor, useSensors,
  type Announcements, type CollisionDetection, type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FolderPlus, GripVertical, ListPlus, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';
import { createContext, useContext, useLayoutEffect, useRef, useState, type KeyboardEvent as KE, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSetNavLayout } from '@/api/settings';
import type { NavLayoutSetting } from '@/api/types';
import { ICONS, ICON_PROPS, type Concept } from '@/lib/icons';
import {
  addMain, addSub, dropOn, headingCount, headingIcon, headingName, headRef, isSub, itemRef, keyMove, MAX_HEADINGS, MAX_MAIN, NAME_MAX, NAV_SIDE, OTHER_ID, position,
  removeHeading, renameHeading, resolveLayout, sameLayout, type Layout, type NavHead, type NavSub, type Ref,
} from '@/lib/navLayout';
import { errText, FormDialog } from './FormDialog';
import { useToast } from './Toast';

type HeadingForm = { mode: 'main' } | { mode: 'sub'; main: string } | { mode: 'rename'; id: string };

/** The smallest droppable under the pointer (a row before the heading that holds it); the closest centre when the pointer is outside every droppable. */
const innermost: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (!hits.length) return closestCenter(args);
  const area = (id: string | number) => { const r = args.droppableRects.get(id); return r ? r.width * r.height : Infinity; };
  return [...hits].sort((a, b) => area(a.id) - area(b.id));
};

/**
 * Edit mode of the side menu (owner request 2026-11-09, contract 0.15.1): one shared layout for everyone, edited by a System Admin or an all-regions delegate of
 * settings. Drag and drop with the mouse or a finger (dnd-kit), or with the keyboard on a handle: Space picks, the arrows move, Space drops, Escape cancels; every
 * step is announced. Main headings and sub-headings (EN and AR names, an optional icon) are added, renamed and deleted (a deleted heading's entries move up, or to
 * "Other"; a screen is never deleted). Save and Reset ask for a reason and send If-Match.
 */
export function NavLayoutEditor({ setting, onDone }: { setting: NavLayoutSetting | undefined; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const set = useSetNavLayout();
  const [initial] = useState<Layout>(() => resolveLayout(setting?.layout ?? null));
  const [draft, setDraft] = useState<Layout>(initial);
  const [picked, setPicked] = useState<{ ref: Ref; before: Layout } | null>(null);
  const [live, setLive] = useState('');
  const [form, setForm] = useState<HeadingForm | null>(null);
  const [confirm, setConfirm] = useState<'save' | 'reset' | null>(null);
  const handles = useRef(new Map<Ref, HTMLElement>());
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 5 } }), useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }));
  const lang = i18n.language;
  const itemLabel = (k: string) => t(k === 'sites' ? 'nav.sites_all' : `nav.${k}`);
  const nameOf = (ref: Ref) => {
    if (ref.startsWith('i:')) return itemLabel(ref.slice(2));
    const id = ref.replace(/^(h|end):/, '');
    const h = draft.headings.find((x) => x.id === id) ?? draft.headings.flatMap((x) => x.children.filter(isSub)).find((s) => s.id === id);
    return h ? headingName(h, lang) : id;
  };
  const where = (l: Layout, ref: Ref) => {
    const p = position(l, ref);
    if (!p) return null;
    return { index: p.index, count: p.count, where: p.container ? t('navEdit.in_heading', { heading: headingName(p.container, lang) }) : t('navEdit.top_level') };
  };
  const dirty = !sameLayout(draft, initial);

  // keep the focus on the handle of the picked entry when it moves to another list (its element is mounted again)
  useLayoutEffect(() => { if (picked) handles.current.get(picked.ref)?.focus(); }, [draft, picked]);

  const onHandleKey = (ref: Ref) => (e: KE) => {
    const name = nameOf(ref);
    if (!picked) {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        setPicked({ ref, before: draft });
        setLive(t('navEdit.picked', { name, ...where(draft, ref) }));
      }
      return;
    }
    if (picked.ref !== ref) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = keyMove(draft, ref, e.key === 'ArrowUp' ? -1 : 1);
      if (!next) { setLive(t('navEdit.cannot', { name })); return; }
      setDraft(next);
      setLive(t('navEdit.moved', { name, ...where(next, ref) }));
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      setPicked(null);
      setLive(t('navEdit.dropped', { name, ...where(draft, ref) }));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setDraft(picked.before);
      setPicked(null);
      setLive(t('navEdit.cancelled', { name }));
    } else if (e.key === 'Tab') {
      // leaving the handle drops the entry where it is
      setPicked(null);
      setLive(t('navEdit.dropped', { name, ...where(draft, ref) }));
    }
  };

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over) return;
    const ref = String(e.active.id);
    const next = dropOn(draft, ref, String(e.over.id));
    if (next) { setDraft(next); setLive(t('navEdit.dropped', { name: nameOf(ref), ...where(next, ref) })); }
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('navEdit.picked', { name: nameOf(String(active.id)), ...where(draft, String(active.id)) }),
    onDragOver: ({ active, over }) => (over ? t('navEdit.over', { name: nameOf(String(active.id)), target: nameOf(String(over.id)) }) : undefined),
    onDragEnd: ({ active }) => t('navEdit.dropped', { name: nameOf(String(active.id)), ...where(draft, String(active.id)) }),
    onDragCancel: () => t('navEdit.drag_cancelled'),
  };

  const total = headingCount(draft);
  const del = (h: NavHead | NavSub) => {
    const next = removeHeading(draft, h.id);
    if (!next) { setLive(t('navEdit.other_locked')); return; }
    const isMain = draft.headings.some((x) => x.id === h.id);
    const parent = isMain ? null : draft.headings.find((x) => x.children.some((c) => isSub(c) && c.id === h.id));
    setDraft(next);
    setLive(t('navEdit.deleted', { name: headingName(h, lang), target: parent ? headingName(parent, lang) : t('navEdit.other') }));
  };

  const ctx: EditCtxT = {
    draft, lang, t, total, itemLabel, setForm, del,
    handle: (ref, label, sortable) => (
      <button type="button" {...sortable.attributes} {...sortable.listeners} onKeyDown={onHandleKey(ref)}
        ref={(el) => { sortable.setActivatorNodeRef(el); if (el) handles.current.set(ref, el); else handles.current.delete(ref); }}
        data-handle={ref} data-testid={`nav-edit-handle-${ref}`} aria-label={t('navEdit.move', { name: label })} aria-pressed={picked?.ref === ref}
        className={`cursor-grab touch-none rounded p-1 text-faint hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${picked?.ref === ref ? 'bg-accentSoft text-ink' : ''}`}>
        <GripVertical size={14} aria-hidden />
      </button>
    ),
  };

  const formHeading = form?.mode === 'rename' ? draft.headings.find((x) => x.id === form.id) ?? draft.headings.flatMap((x) => x.children.filter(isSub)).find((x) => x.id === form.id) : undefined;
  const mainOf = form?.mode === 'sub' ? draft.headings.find((x) => x.id === form.main) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="nav-editor" role="region" aria-label={t('navEdit.title')}>
      <div className="space-y-2 px-3 pb-2">
        <p className="text-sm font-bold">{t('navEdit.title')}</p>
        <p id="nav-edit-help" className="text-xs text-mute" data-testid="nav-edit-help">{t('navEdit.help')}</p>
        <div className="flex flex-wrap gap-1">
          <button type="button" className="btn btn-sm" data-testid="nav-edit-add-main" disabled={draft.headings.length >= MAX_MAIN || total >= MAX_HEADINGS} onClick={() => setForm({ mode: 'main' })}>
            <FolderPlus size={14} aria-hidden />{t('navEdit.add_main')}
          </button>
          <button type="button" className="btn btn-sm" data-testid="nav-edit-reset" disabled={!!setting?.is_default || !setting} onClick={() => setConfirm('reset')}>
            <RotateCcw size={14} aria-hidden />{t('navEdit.reset')}
          </button>
        </div>
        {(draft.headings.length >= MAX_MAIN || total >= MAX_HEADINGS) && <p className="text-xs text-mute">{t('navEdit.too_many')}</p>}
      </div>
      <div role="status" aria-live="assertive" aria-atomic="true" className="sr-only" data-testid="nav-edit-live">{live}</div>
      <div className="flex-1 overflow-y-auto px-2">
        <DndContext sensors={sensors} collisionDetection={innermost} onDragEnd={onDragEnd}
          accessibility={{ announcements, screenReaderInstructions: { draggable: t('navEdit.help') } }}>
          <SortableContext items={draft.headings.map((h) => headRef(h.id))} strategy={verticalListSortingStrategy}>
            <EditCtx.Provider value={ctx}>
              <ul aria-label={t('navEdit.title')} data-testid="nav-edit-tree">{draft.headings.map((h) => <Main key={h.id} h={h} />)}</ul>
            </EditCtx.Provider>
          </SortableContext>
        </DndContext>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
        {dirty && <span className="text-xs text-mute" data-testid="nav-edit-dirty">{t('navEdit.unsaved')}</span>}
        <span className="flex-1" />
        <button type="button" className="btn btn-sm" data-testid="nav-edit-cancel" onClick={onDone}>{t('navEdit.cancel')}</button>
        <button type="button" className="btn btn-accent btn-sm" data-testid="nav-edit-save" disabled={!dirty || !setting} onClick={() => setConfirm('save')}>{t('navEdit.save')}</button>
      </div>

      {form && (
        <HeadingDialog
          title={form.mode === 'main' ? t('navEdit.new_main') : form.mode === 'sub' ? t('navEdit.new_sub', { heading: mainOf ? headingName(mainOf, lang) : '' }) : t('navEdit.edit_heading')}
          initial={formHeading ?? null}
          onClose={() => setForm(null)}
          onSubmit={(v) => {
            if (form.mode === 'main') setDraft(addMain(draft, v));
            else if (form.mode === 'sub') setDraft(addSub(draft, form.main, v));
            else setDraft(renameHeading(draft, form.id, v));
            setForm(null);
          }} />
      )}
      {confirm && setting && (
        <FormDialog open testid="nav-edit-confirm" title={t(confirm === 'save' ? 'navEdit.save_title' : 'navEdit.reset_title')} onClose={() => setConfirm(null)}
          busy={set.isPending} error={set.isError ? errText(set.error, t) : null} submitLabel={t(confirm === 'save' ? 'navEdit.save' : 'navEdit.reset')}
          onSubmit={(reason) => set.mutate({ version: setting.version, layout: confirm === 'save' ? draft : null, reason }, {
            onSuccess: () => { toast(t(confirm === 'save' ? 'navEdit.saved' : 'navEdit.reset_done')); setConfirm(null); onDone(); },
          })}>
          <p className="text-sm text-mute">{t(confirm === 'save' ? 'navEdit.save_note' : 'navEdit.reset_note')}</p>
        </FormDialog>
      )}
    </div>
  );
}

/** Name EN and AR (both required, 1 to 60 characters) and an optional icon of the icon set. */
function HeadingDialog({ title, initial, onClose, onSubmit }: {
  title: string; initial: { name_en: string; name_ar: string; icon: string | null } | null; onClose: () => void; onSubmit: (v: { name_en: string; name_ar: string; icon: string | null }) => void;
}) {
  const { t } = useTranslation();
  const [en, setEn] = useState(initial?.name_en ?? '');
  const [ar, setAr] = useState(initial?.name_ar ?? '');
  const [icon, setIcon] = useState<string>(initial?.icon ?? '');
  const [tried, setTried] = useState(false);
  const ok = (v: string) => v.trim().length >= 1 && v.trim().length <= NAME_MAX;
  const valid = ok(en) && ok(ar);
  return (
    <FormDialog open testid="nav-heading-dialog" title={title} withReason={false} onClose={onClose} submitLabel={t('common.save')}
      onSubmit={() => { if (!valid) { setTried(true); return; } onSubmit({ name_en: en.trim(), name_ar: ar.trim(), icon: icon || null }); }}>
      <div className="space-y-2">
        <label className="block text-sm font-semibold" htmlFor="nav-heading-en">{t('navEdit.name_en')}</label>
        <input id="nav-heading-en" dir="ltr" lang="en" className="input" data-testid="nav-heading-en" maxLength={NAME_MAX} value={en} aria-invalid={tried && !ok(en)} onChange={(e) => setEn(e.target.value)} />
        <label className="block text-sm font-semibold" htmlFor="nav-heading-ar">{t('navEdit.name_ar')}</label>
        <input id="nav-heading-ar" dir="rtl" lang="ar" className="input" data-testid="nav-heading-ar" maxLength={NAME_MAX} value={ar} aria-invalid={tried && !ok(ar)} onChange={(e) => setAr(e.target.value)} />
        <label className="block text-sm font-semibold" htmlFor="nav-heading-icon">{t('navEdit.icon')}</label>
        <select id="nav-heading-icon" className="input" data-testid="nav-heading-icon" value={icon} onChange={(e) => setIcon(e.target.value)}>
          <option value="">{t('navEdit.no_icon')}</option>
          {(Object.keys(ICONS) as Concept[]).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {tried && !valid && <p role="alert" className="text-sm text-lateInk" data-testid="nav-heading-error">{t('navEdit.name_required')}</p>}
      </div>
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------- the rows of the tree
type Sortable = ReturnType<typeof useSortable>;
type Grip = Pick<Sortable, 'attributes' | 'listeners' | 'setActivatorNodeRef'>;
interface EditCtxT {
  draft: Layout; lang: string; t: TFunction; total: number; itemLabel: (k: string) => string;
  setForm: (f: HeadingForm) => void; del: (h: NavHead | NavSub) => void; handle: (ref: Ref, label: string, g: Grip) => ReactNode;
}
const EditCtx = createContext<EditCtxT | null>(null);
const useEdit = () => useContext(EditCtx)!;
const moving = (transform: Sortable['transform'], transition: Sortable['transition']) => ({ transform: CSS.Transform.toString(transform), transition });

const iconBtn = (testid: string, label: string, onClick: () => void, icon: ReactNode, disabled = false) => (
  <button type="button" data-testid={testid} aria-label={label} title={label} disabled={disabled} onClick={onClick} className="rounded p-1 text-faint hover:bg-hover hover:text-ink disabled:opacity-30">{icon}</button>
);

function Item({ k }: { k: string }) {
  const { handle, itemLabel } = useEdit();
  const ref = itemRef(k);
  const { setNodeRef, transform, transition, isDragging, attributes, listeners, setActivatorNodeRef } = useSortable({ id: ref });
  const grip: Grip = { attributes, listeners, setActivatorNodeRef };
  const n = NAV_SIDE.find((x) => x.key === k)!;
  const Icon = ICONS[n.icon];
  return (
    <li ref={setNodeRef} style={moving(transform, transition)} data-testid={`nav-edit-item-${k}`} className={`flex items-center gap-2 rounded-md px-1 py-1 text-sm ${isDragging ? 'bg-hover opacity-60' : ''}`}>
      {handle(ref, itemLabel(k), grip)}
      <Icon {...ICON_PROPS} className="shrink-0" />
      <span className="truncate">{itemLabel(k)}</span>
    </li>
  );
}

/** The end of a heading: a drop target, also for an empty heading. */
function End({ id }: { id: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `end:${id}` });
  return <li ref={setNodeRef} aria-hidden className={`min-h-2 rounded ${isOver ? 'bg-accentSoft' : ''}`} />;
}

function HeadingRow({ h, grip, sub }: { h: NavHead | NavSub; grip: Grip; sub: boolean }) {
  const { draft, lang, t, total, setForm, del, handle } = useEdit();
  const concept = headingIcon(h);
  const Icon = concept ? ICONS[concept] : null;
  const name = headingName(h, lang);
  const lockedOther = h.id === OTHER_ID && h.children.length > 0;
  return (
    <div className={`flex items-center gap-1 rounded-md px-1 py-1 ${sub ? 'text-xs font-semibold text-mute' : 'text-xs font-bold'}`}>
      {handle(headRef(h.id), name, grip)}
      {Icon && <Icon {...ICON_PROPS} size={14} className="shrink-0" />}
      <span className="flex-1 truncate" data-testid={`nav-edit-name-${h.id}`}>{name}</span>
      {!sub && iconBtn(`nav-edit-add-sub-${h.id}`, `${t('navEdit.add_sub')}: ${name}`, () => setForm({ mode: 'sub', main: h.id }), <ListPlus size={14} aria-hidden />, total >= MAX_HEADINGS)}
      {iconBtn(`nav-edit-rename-${h.id}`, `${t('navEdit.rename')}: ${name}`, () => setForm({ mode: 'rename', id: h.id }), <Pencil size={14} aria-hidden />)}
      {iconBtn(`nav-edit-delete-${h.id}`, `${t('navEdit.delete')}: ${name}`, () => del(h), <Trash2 size={14} aria-hidden />, lockedOther || (!sub && draft.headings.length === 1 && h.children.length === 0))}
    </div>
  );
}

function Sub({ h }: { h: NavSub }) {
  const { lang, t } = useEdit();
  const { setNodeRef, transform, transition, isDragging, attributes, listeners, setActivatorNodeRef } = useSortable({ id: headRef(h.id) });
  const grip: Grip = { attributes, listeners, setActivatorNodeRef };
  return (
    <li ref={setNodeRef} style={moving(transform, transition)} data-testid={`nav-edit-heading-${h.id}`} data-depth="2" className={`ms-3 rounded-md border-s border-line ps-1 ${isDragging ? 'opacity-60' : ''}`}>
      <HeadingRow h={h} grip={grip} sub />
      <SortableContext items={h.children.map(itemRef)} strategy={verticalListSortingStrategy}>
        <ul className="ms-3" aria-label={headingName(h, lang)}>
          {h.children.map((k) => <Item key={k} k={k} />)}
          {!h.children.length && <li className="px-2 py-1 text-xs text-faint">{t('navEdit.empty')}</li>}
          <End id={h.id} />
        </ul>
      </SortableContext>
    </li>
  );
}

function Main({ h }: { h: NavHead }) {
  const { lang, t } = useEdit();
  const { setNodeRef, transform, transition, isDragging, attributes, listeners, setActivatorNodeRef } = useSortable({ id: headRef(h.id) });
  const grip: Grip = { attributes, listeners, setActivatorNodeRef };
  return (
    <li ref={setNodeRef} style={moving(transform, transition)} data-testid={`nav-edit-heading-${h.id}`} data-depth="1" className={`mb-2 rounded-md border border-line p-1 ${isDragging ? 'opacity-60' : ''}`}>
      <HeadingRow h={h} grip={grip} sub={false} />
      <SortableContext items={h.children.map((c) => (isSub(c) ? headRef(c.id) : itemRef(c)))} strategy={verticalListSortingStrategy}>
        <ul aria-label={headingName(h, lang)}>
          {h.children.map((c) => (isSub(c) ? <Sub key={`h:${c.id}`} h={c} /> : <Item key={c} k={c} />))}
          {!h.children.length && <li className="px-2 py-1 text-xs text-faint">{t('navEdit.empty')}</li>}
          <End id={h.id} />
        </ul>
      </SortableContext>
    </li>
  );
}
