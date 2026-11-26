import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

type Action = { label: string; onClick: () => void };
type T = { id: number; text: string; kind: 'ok' | 'err'; action?: Action };
/** `opts.action` adds one button (for example Undo); `opts.ms` keeps the toast longer than the default 5 s. */
type Push = (text: string, kind?: T['kind'], opts?: { action?: Action; ms?: number }) => void;
const Ctx = createContext<Push>(() => {});
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<T[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  // A pending dismiss timer must not fire after unmount (tests tear down the DOM).
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const push = useCallback<Push>((text, kind = 'ok', opts) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, kind, action: opts?.action }]);
    const t = setTimeout(() => {
      timers.current.delete(t);
      setItems((x) => x.filter((i) => i.id !== id));
    }, opts?.ms ?? 5000);
    timers.current.add(t);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div role="status" aria-live="polite" className="fixed bottom-4 end-4 z-[60] flex flex-col gap-2">
        {items.map((i) => (
          <div key={i.id} data-testid="toast" data-kind={i.kind} className={`motion-rise card px-4 py-2 text-sm font-semibold ${i.kind === 'err' ? 'text-lateInk bg-lateBg' : 'text-doneInk bg-doneBg'}`}>{i.text}{i.action && <button type="button" className="btn ms-3" data-testid="toast-action" onClick={() => { i.action!.onClick(); setItems((x) => x.filter((y) => y.id !== i.id)); }}>{i.action.label}</button>}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
