import * as Dialog from '@radix-ui/react-dialog';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { UNSAFE_NavigationContext } from 'react-router-dom';
import { useUiFeatures } from '@/api/uiFeatures';

/**
 * Decision 11: ONE guard for unsaved input, everywhere data can be edited. A screen (Settings page, inline edit, composer) registers its dirty state
 * with `useUnsavedGuard`; a dialog or drawer asks through `askLeave` before it closes. In-app links, the browser Back button and closing the tab
 * all go through the same three choices: Save and leave, Discard and leave, Stay. The switch and the per-area scopes are the setting
 * ui.features.unsaved_guard (Administration > Settings > Screens > Interface).
 */
export type GuardScope = 'settings' | 'dialogs' | 'drawers' | 'inline' | 'composers';

export interface GuardSource {
  scope: GuardScope;
  dirty: boolean;
  /** Saves the input; false (or a throw) means it could not be saved, so the user stays with an error; 'stay' means the save was started and the screen closes itself when it succeeds. Omit when the area has no way to save from here. */
  onSave?: (reason: string) => Promise<boolean | 'stay' | void> | boolean | 'stay' | void;
  /** The save needs a reason (Settings doors): the leave dialog then asks for it (3 characters at least) and passes it to onSave. */
  needsReason?: boolean;
  label?: string;
}

interface Pending { sources: GuardSource[]; proceed: () => void }
interface Api {
  /** Runs `proceed` at once when nothing is dirty (or the guard is off for the scope), else asks first. */
  askLeave: (sources: GuardSource[], proceed: () => void) => void;
  register: (id: string, s: GuardSource) => void;
  unregister: (id: string) => void;
  enabledFor: (scope: GuardScope) => boolean;
}

const Ctx = createContext<Api | null>(null);

export function UnsavedGuardProvider({ children }: { children: ReactNode }) {
  const ui = useUiFeatures().unsaved_guard;
  const nav = useContext(UNSAFE_NavigationContext);
  const sources = useRef(new Map<string, GuardSource>());
  const [pending, setPending] = useState<Pending | null>(null);
  const skip = useRef(false);
  const enabledFor = useCallback((scope: GuardScope) => ui.enabled && ui[scope], [ui]);
  const live = useCallback(() => [...sources.current.values()].filter((s) => s.dirty && enabledFor(s.scope)), [enabledFor]);
  const askLeave = useCallback((list: GuardSource[], proceed: () => void) => {
    const dirty = list.filter((s) => s.dirty && enabledFor(s.scope));
    if (!dirty.length) proceed();
    // the user already answered: the navigation inside `proceed` (a drawer moving to another row, a dialog closing) must not ask again
    else setPending({ sources: dirty, proceed: () => { skip.current = true; try { proceed(); } finally { skip.current = false; } } });
  }, [enabledFor]);
  const api = useMemo<Api>(() => ({
    askLeave, enabledFor,
    register: (id, s) => { sources.current.set(id, s); },
    unregister: (id) => { sources.current.delete(id); },
  }), [askLeave, enabledFor]);

  // in-app navigation: every link and navigate() call goes through the router's navigator
  useEffect(() => {
    const n = nav.navigator as unknown as { push: (...a: unknown[]) => void; replace: (...a: unknown[]) => void; go: (d: number) => void };
    if (!ui.enabled || !ui.navigation) return undefined;
    const { push, replace, go } = n;
    const wrap = (orig: (...a: unknown[]) => void) => (...a: unknown[]) => {
      if (skip.current) { orig.apply(n, a); return; }
      askLeave(live(), () => { skip.current = true; try { orig.apply(n, a); } finally { skip.current = false; } });
    };
    n.push = wrap(push); n.replace = wrap(replace);
    n.go = (d: number) => { if (skip.current) go.call(n, d); else askLeave(live(), () => { skip.current = true; go.call(n, d); skip.current = false; }); };
    return () => { n.push = push; n.replace = replace; n.go = go; };
  }, [nav, ui.enabled, ui.navigation, askLeave, live]);

  // the browser Back/Forward buttons cannot be cancelled: restore the entry, ask, and go again when the user leaves
  useEffect(() => {
    if (!ui.enabled || !ui.navigation) return undefined;
    let restoring = 0;
    const onPop = (e: PopStateEvent) => {
      if (restoring > 0) { restoring -= 1; return; }
      if (skip.current || !live().length) return;
      const idx = (e.state as { idx?: number } | null)?.idx;
      const cur = (window.history.state as { idx?: number } | null)?.idx;
      const delta = typeof idx === 'number' && typeof cur === 'number' ? idx - cur : -1;
      restoring += 1;
      window.history.go(-delta || 1);
      askLeave(live(), () => { restoring += 1; window.history.go(delta || -1); });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [ui.enabled, ui.navigation, askLeave, live]);

  // closing or reloading the tab: the browser's own prompt (the page cannot show its dialog there)
  useEffect(() => {
    if (!ui.enabled || !ui.navigation) return undefined;
    const h = (e: BeforeUnloadEvent) => { if (live().length) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [ui.enabled, ui.navigation, live]);

  return <Ctx.Provider value={api}>{children}<LeaveDialog pending={pending} onClose={() => setPending(null)} /></Ctx.Provider>;
}

function LeaveDialog({ pending, onClose }: { pending: Pending | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reason, setReason] = useState('');
  const needReason = !!pending?.sources.some((s) => s.needsReason);
  const shortReason = needReason && reason.trim().length < 3;
  const canSave = !!pending && pending.sources.every((s) => !!s.onSave);
  const go = () => { const p = pending; onClose(); setFailed(false); setReason(''); p?.proceed(); };
  const save = async () => {
    if (!pending) return;
    setBusy(true); setFailed(false);
    try {
      for (const s of pending.sources) {
        const r = await s.onSave?.(reason.trim());
        if (r === false) { setFailed(true); return; }
        if (r === 'stay') { onClose(); setReason(''); return; }
      }
      go();
    } catch { setFailed(true); } finally { setBusy(false); }
  };
  const names = pending?.sources.map((s) => s.label).filter(Boolean).join(', ');
  return (
    <Dialog.Root open={!!pending} onOpenChange={(o) => { if (!o) { setFailed(false); onClose(); } }}>
      <Dialog.Portal>
        <Dialog.Overlay className="motion-overlay fixed inset-0 z-[90] bg-scrim/60" />
        <Dialog.Content data-testid="unsaved-dialog" className="motion-panel card fixed inset-x-0 top-[20vh] z-[90] mx-auto w-[min(440px,94vw)] space-y-3 p-5"
          onOpenAutoFocus={(e) => { e.preventDefault(); document.querySelector<HTMLElement>('[data-testid="unsaved-stay"]')?.focus(); }}>
          <Dialog.Title className="text-lg font-bold">{t('unsaved.title')}</Dialog.Title>
          <Dialog.Description className="text-sm text-mute">{t('unsaved.body')}{names ? ` (${names})` : ''}</Dialog.Description>
          {needReason && canSave && (
            <label className="block text-sm font-semibold">{t('common.reason')}
              <textarea className="input mt-1 min-h-14 font-normal" data-testid="unsaved-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              <span className="text-xs font-normal text-mute">{t('unsaved.reason_note')}</span>
            </label>
          )}
          {failed && <p role="alert" data-testid="unsaved-failed" className="text-lateInk">{t('unsaved.save_failed')}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button className="btn btn-accent" data-testid="unsaved-stay" onClick={onClose} title={t('unsaved.stay_hint')}>{t('unsaved.stay')}</button>
            <button className="btn btn-danger" data-testid="unsaved-discard" onClick={go} title={t('unsaved.discard_hint')}>{t('unsaved.discard')}</button>
            {canSave && <button className="btn" data-testid="unsaved-save" disabled={busy || shortReason} onClick={() => void save()} title={t('unsaved.save_hint')}>{t('unsaved.save')}</button>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const NOOP: Api = { askLeave: (_s, p) => p(), register: () => undefined, unregister: () => undefined, enabledFor: () => false };
export const useGuardApi = (): Api => useContext(Ctx) ?? NOOP;

/** Registers the dirty state of a screen. The newest `onSave` is always used; the entry goes away when the screen unmounts. */
export function useUnsavedGuard(s: GuardSource): void {
  const { register, unregister } = useGuardApi();
  const id = useRef(`g${Math.random().toString(36).slice(2)}`).current;
  register(id, s);
  useEffect(() => () => unregister(id), [id, unregister]);
}

/** For a dialog or drawer: `ask(close)` closes at once when clean, else shows the three choices first. */
export function useAskLeave(s: GuardSource): (proceed: () => void) => void {
  const { askLeave } = useGuardApi();
  return useCallback((proceed: () => void) => askLeave([s], proceed), [askLeave, s]);
}

/** The same as useUnsavedGuard, as an element: a screen that returns early before its dirty state is known places it in its JSX. */
export function UnsavedGuard(props: GuardSource): null {
  useUnsavedGuard(props);
  return null;
}
