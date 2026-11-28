import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

type Action = { label: string; onClick: () => void };
type T = { id: number; text: string; kind: 'ok' | 'err'; action?: Action };
/**
 * The standard notice of a finished operation: bottom corner (right in English, left in Arabic), a green check and the text, gone by itself after 4.5 s.
 * An error is red, stays until it is closed with its close button, and is never timed out unless `opts.ms` is given. `opts.action` adds one button
 * (for example Undo); `opts.ms` sets another time.
 */
type Push = (text: string, kind?: T['kind'], opts?: { action?: Action; ms?: number }) => void;
const Ctx = createContext<Push>(() => {});
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<T[]>([]);
  const { t } = useTranslation();
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  // A pending dismiss timer must not fire after unmount (tests tear down the DOM).
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const push = useCallback<Push>((text, kind = 'ok', opts) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, kind, action: opts?.action }]);
    if (kind === 'err' && opts?.ms === undefined) return;
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setItems((x) => x.filter((i) => i.id !== id));
    }, opts?.ms ?? 4500);
    timers.current.add(timer);
  }, []);
  const dismiss = useCallback((id: number) => setItems((x) => x.filter((i) => i.id !== id)), []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div role="status" aria-live="polite" className="fixed bottom-4 end-4 z-[60] flex flex-col gap-2">
        {items.map((i) => (
          <div key={i.id} data-testid="toast" data-kind={i.kind} className={`motion-rise card flex items-center gap-2 px-4 py-2 text-sm font-semibold ${i.kind === 'err' ? 'bg-lateBg text-lateInk' : 'bg-doneBg text-doneInk'}`}>
            {i.kind === 'err' ? <AlertCircle size={16} aria-hidden className="shrink-0" /> : <CheckCircle2 size={16} aria-hidden className="shrink-0" data-testid="toast-check" />}
            <span>{i.text || t('toast.done')}</span>
            {i.action && <button type="button" className="btn ms-2 px-2 py-0.5 text-xs" data-testid="toast-action" onClick={() => { i.action?.onClick(); dismiss(i.id); }}>{i.action.label}</button>}
            {i.kind === 'err' && <button type="button" className="ms-1 rounded p-0.5 hover:bg-hover" data-testid="toast-close" aria-label={t('toast.close')} title={t('toast.close')} onClick={() => dismiss(i.id)}><X size={14} aria-hidden /></button>}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
