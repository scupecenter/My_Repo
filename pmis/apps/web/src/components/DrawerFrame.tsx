import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Maximize2, Minimize2 } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as RKeyboardEvent,
  type PointerEvent as RPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { loadPref, savePref } from "@/lib/localPref";
import { Tip } from "./Tip";

export const DRAWER_MIN = 360;
type Size = { w: number; full: boolean };
const clampW = (w: number) =>
  Math.round(
    Math.min(
      Math.max(DRAWER_MIN, w),
      typeof window === "undefined" ? 1200 : window.innerWidth * 0.95,
    ),
  );

const Ctx = createContext<{ report: (dirty: boolean) => void }>({
  report: () => {},
});
/** A drawer body tells its frame whether it holds unsaved input, so closing or moving to another row can ask first (plan E6, R4). */
export function useReportDirty(dirty: boolean) {
  const { report } = useContext(Ctx);
  useEffect(() => {
    report(dirty);
    return () => report(false);
  }, [dirty, report]);
}

export type DrawerNav = {
  ids: string[];
  current: string | null;
  onGo: (id: string) => void;
};

/** Shared drawer shell: resizable width and full-screen (remembered per drawer), prev/next through the current list, unsaved-changes guard, focus back to the originating row. */
export function DrawerFrame({
  name,
  open,
  onClose,
  testid,
  nav,
  wide = 560,
  children,
}: {
  name: string;
  open: boolean;
  onClose: () => void;
  testid: string;
  nav?: DrawerNav;
  wide?: number;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const key = `pmis.drawer.${name}`;
  const [size, setSize] = useState<Size>(() => {
    const s = loadPref<Partial<Size>>(key, {});
    return { w: clampW(s.w ?? wide), full: !!s.full };
  });
  const dirty = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const [pending, setPending] = useState<null | (() => void)>(null);
  const put = (s: Size) => {
    setSize(s);
    savePref(key, s);
  };
  const guard = (go: () => void) => {
    if (dirty.current) setPending(() => go);
    else go();
  };

  const i = nav?.current ? nav.ids.indexOf(nav.current) : -1;
  const step = (d: -1 | 1) => {
    const id = nav?.ids[i + d];
    if (id) guard(() => nav?.onGo(id));
  };

  const drag = (e: RPointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX,
      w0 = size.w,
      dir = document.documentElement.dir === "rtl" ? 1 : -1; // the drawer sits at the inline end: dragging towards the start widens it
    const mv = (ev: PointerEvent) =>
      setSize((s) => ({ ...s, w: clampW(w0 + dir * (ev.clientX - x0)) }));
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      setSize((s) => {
        savePref(key, s);
        return s;
      });
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };
  const key2 = (e: RKeyboardEvent) => {
    const flip = document.documentElement.dir === "rtl" ? -1 : 1;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      put({
        ...size,
        w: clampW(size.w + (e.key === "ArrowLeft" ? 24 : -24) * flip),
      });
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) guard(onClose);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-scrim/50" />
        <Dialog.Content
          data-testid={testid}
          data-full={size.full}
          aria-describedby={undefined}
          onOpenAutoFocus={() => {
            opener.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (opener.current?.isConnected) opener.current.focus();
          }}
          className="fixed inset-y-0 end-0 z-[60] max-w-full border-s border-line bg-card shadow-lg"
          style={{ width: size.full ? "100vw" : size.w }}
        >
          {!size.full && (
            <div
              role="separator"
              aria-orientation="vertical"
              tabIndex={0}
              aria-label={t("drawer.resize")}
              aria-valuenow={size.w}
              aria-valuemin={DRAWER_MIN}
              data-testid="drawer-resize"
              className="absolute inset-y-0 start-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-accent focus-visible:bg-accent rtl:translate-x-1/2"
              onPointerDown={drag}
              onKeyDown={key2}
            />
          )}
          <Ctx.Provider
            value={{
              report: (d) => {
                dirty.current = d;
              },
            }}
          >
            <div className="flex h-full flex-col">
              <div
                className="flex items-center gap-1 border-b border-line px-3 py-1 text-sm"
                data-testid="drawer-bar"
              >
                {nav && (
                  <>
                    <Tip text={t("drawer.prev")}>
                      <button
                        type="button"
                        className="btn px-2 py-1"
                        aria-label={t("drawer.prev")}
                        data-testid="drawer-prev"
                        disabled={i <= 0}
                        onClick={() => step(-1)}
                      >
                        <ChevronLeft size={14} className="rtl:rotate-180" />
                      </button>
                    </Tip>
                    <Tip text={t("drawer.next")}>
                      <button
                        type="button"
                        className="btn px-2 py-1"
                        aria-label={t("drawer.next")}
                        data-testid="drawer-next"
                        disabled={i < 0 || i >= nav.ids.length - 1}
                        onClick={() => step(1)}
                      >
                        <ChevronRight size={14} className="rtl:rotate-180" />
                      </button>
                    </Tip>
                    {i >= 0 && (
                      <span
                        className="mono text-mute"
                        data-testid="drawer-position"
                      >
                        {t("drawer.position", {
                          n: i + 1,
                          total: nav.ids.length,
                        })}
                      </span>
                    )}
                  </>
                )}
                <Tip
                  text={size.full ? t("drawer.restore") : t("drawer.expand")}
                >
                  <button
                    type="button"
                    className="btn ms-auto px-2 py-1"
                    aria-pressed={size.full}
                    aria-label={
                      size.full ? t("drawer.restore") : t("drawer.expand")
                    }
                    data-testid="drawer-expand"
                    onClick={() => put({ ...size, full: !size.full })}
                  >
                    {size.full ? (
                      <Minimize2 size={14} />
                    ) : (
                      <Maximize2 size={14} />
                    )}
                  </button>
                </Tip>
              </div>
              <div className="min-h-0 flex-1">{children}</div>
            </div>
          </Ctx.Provider>
          {pending && (
            <div
              role="alertdialog"
              aria-labelledby="dr-discard-t"
              data-testid="drawer-discard"
              className="absolute inset-0 z-20 flex items-center justify-center bg-scrim/50 p-4"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setPending(null);
                }
              }}
            >
              <div className="card w-full max-w-sm space-y-3 p-4">
                <h2 id="dr-discard-t" className="font-bold">
                  {t("drawer.discard_title")}
                </h2>
                <p className="text-sm text-mute">{t("drawer.discard_body")}</p>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    autoFocus
                    className="btn"
                    data-testid="drawer-discard-keep"
                    onClick={() => setPending(null)}
                  >
                    {t("drawer.discard_keep")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    data-testid="drawer-discard-go"
                    onClick={() => {
                      const go = pending;
                      setPending(null);
                      dirty.current = false;
                      go();
                    }}
                  >
                    {t("drawer.discard_go")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Tab strip for a drawer; panels stay mounted (hidden) so typed input survives a tab switch. */
export function DrawerTabs({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div
      role="tablist"
      className="flex gap-1 border-b border-line px-4"
      data-testid="drawer-tabs"
    >
      {tabs.map((x) => (
        <button
          key={x.id}
          type="button"
          role="tab"
          id={`dtab-${x.id}`}
          aria-selected={value === x.id}
          aria-controls={`dpanel-${x.id}`}
          data-testid={`drawer-tab-${x.id}`}
          onClick={() => onChange(x.id)}
          className={`px-3 py-2 text-sm font-semibold ${value === x.id ? "border-b-2 border-accent text-accentText" : "text-mute hover:text-ink"}`}
        >
          {x.label}
        </button>
      ))}
    </div>
  );
}
export const panelProps = (id: string, value: string) => ({
  role: "tabpanel" as const,
  id: `dpanel-${id}`,
  "aria-labelledby": `dtab-${id}`,
  hidden: value !== id,
});
