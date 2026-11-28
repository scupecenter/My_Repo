import * as Dialog from "@radix-ui/react-dialog";
import { Check, ChevronLeft, ChevronRight, Link2, Maximize2, Minimize2 } from "lucide-react";
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
import { useAskLeave, useUnsavedGuard, type GuardSource } from "@/lib/unsavedGuard";
import { useTranslation } from "react-i18next";
import { loadPref, savePref } from "@/lib/localPref";
import { copyText, useExtra } from "@/lib/uiExtras";
import { Tip } from "./Tip";
import { PrivateNotePanel } from "./PrivateNotePanel";
import type { NoteEntity } from "@/api/privateNotes";

export const DRAWER_MIN = 360;
type Size = { w: number; full: boolean };
const clampW = (w: number) =>
  Math.round(
    Math.min(
      Math.max(DRAWER_MIN, w),
      typeof window === "undefined" ? 1200 : window.innerWidth * 0.95,
    ),
  );

const Ctx = createContext<{ report: (dirty: boolean) => void; settle: () => void }>({
  report: () => {},
  settle: () => {},
});
/** The body calls this the moment its save went through and just before it navigates (to the saved record, for instance): the navigation is then not asked about. */
export function useDrawerSettled(): () => void {
  return useContext(Ctx).settle;
}
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
  link,
  note,
  wide = 560,
  children,
}: {
  name: string;
  open: boolean;
  onClose: () => void;
  testid: string;
  nav?: DrawerNav;
  /** Path (and query) that opens this record again; shows the copy-link button. */
  link?: string;
  /** The record this drawer shows, so a private note can be kept on it (needs a saved record). */
  note?: { type: NoteEntity; id: string };
  wide?: number;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const key = `pmis.drawer.${name}`;
  const [size, setSize] = useState<Size>(() => {
    const s = loadPref<Partial<Size>>(key, {});
    return { w: clampW(s.w ?? wide), full: !!s.full };
  });
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const showLink = useExtra("copy_link") && !!link;
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(""), 1800);
    return () => window.clearTimeout(id);
  }, [copied]);
  const dirty = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const put = (s: Size) => {
    setSize(s);
    savePref(key, s);
  };
  // Decision 11: the shared guard (three choices, the setting ui.features.unsaved_guard); the body reports its dirty state through useReportDirty
  const src: GuardSource = { scope: 'drawers', dirty: () => dirty.current, label: name }; // read at the moment of the ask, so settle() takes effect at once
  useUnsavedGuard(src);
  const ask = useAskLeave(src);
  const guard = (go: () => void) => ask(go);

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
              settle: () => {
                dirty.current = false;
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
                {showLink && (
                  <Tip text={t("drawer.copy_link")}>
                    <button
                      type="button"
                      className="btn ms-auto px-2 py-1"
                      aria-label={t("drawer.copy_link")}
                      data-testid="drawer-copy-link"
                      onClick={() => void copyText(new URL(link!, window.location.origin).href).then((ok) => setCopied(ok ? "ok" : "fail"))}
                    >
                      {copied === "ok" ? <Check size={14} /> : <Link2 size={14} />}
                    </button>
                  </Tip>
                )}
                <span role="status" className="text-xs text-mute" data-testid="drawer-copy-note">
                  {copied === "ok" ? t("drawer.link_copied") : copied === "fail" ? t("drawer.link_failed") : ""}
                </span>
                <Tip
                  text={size.full ? t("drawer.restore") : t("drawer.expand")}
                >
                  <button
                    type="button"
                    className={`btn px-2 py-1 ${showLink ? "" : "ms-auto"}`}
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
              {note && <PrivateNotePanel type={note.type} id={note.id} />}
            </div>
          </Ctx.Provider>
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
