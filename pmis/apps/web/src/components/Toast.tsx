import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

type T = { id: number; text: string; kind: 'ok' | 'err' };
const Ctx = createContext<(text: string, kind?: T['kind']) => void>(() => {});
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<T[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  // A pending dismiss timer must not fire after unmount (tests tear down the DOM).
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const push = useCallback((text: string, kind: T['kind'] = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, kind }]);
    const t = setTimeout(() => {
      timers.current.delete(t);
      setItems((x) => x.filter((i) => i.id !== id));
    }, 5000);
    timers.current.add(t);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div role="status" aria-live="polite" className="fixed bottom-4 end-4 z-[60] flex flex-col gap-2">
        {items.map((i) => (
          <div key={i.id} data-testid="toast" data-kind={i.kind} className={`card px-4 py-2 text-sm font-semibold ${i.kind === 'err' ? 'text-lateInk bg-lateBg' : 'text-doneInk bg-doneBg'}`}>{i.text}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
