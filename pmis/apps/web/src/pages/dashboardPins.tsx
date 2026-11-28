import { useQuery } from "@tanstack/react-query";
import { Bell, BellRing, Pin } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api } from "@/api/client";
import type { CountedPage } from "@/api/types";
import { reportViewWatch, useHomePins, useViewWatches, useViewWatchOps, type HomeViewPin } from "@/api/views";
import { Card } from "./dashboardBits";

/**
 * Pinned views (contract 0.15.245, migration 0344; owner request 2026-11-27, item 16 of the 2026-11-27 batch). The caller's pinned saved views as one card, ordered and hidden per tab from Settings > Dashboard like every other card.
 * Personal: the pins are the caller's own (GET /me/home-pins). The counter of a pin is the screen's own list endpoint called with the view's
 * filters and limit 1, so the count is exactly what the caller may see there; the counter is shown for the sites and register screens. A pin
 * opens its screen with the view applied (?view_id).
 *
 * Watch (contract 0.15.487, migration 0628): "alert me when this view has at least N rows". A view is a per-user filter that only the screen's
 * own list endpoint can evaluate for that user, so the server cannot count it alone: on the home load this card reports the count it already
 * read (once per view and page load) and the database writes at most one in-app notification a day to the caller.
 */

/** The screen of a pin: its path and, for the counter, the list endpoint of the screen. */
function targetOf(p: HomeViewPin): { path: string; endpoint: string | null } {
  if (p.screen_key === "sites") return { path: "/sites", endpoint: "/sites" };
  const m = /^register-([a-z0-9_]{2,60})$/.exec(p.screen_key);
  if (m) return { path: `/registers/${m[1]}`, endpoint: `/registers/${m[1]}/records` };
  return { path: "", endpoint: null };
}

function PinRow({ pin }: { pin: HomeViewPin }) {
  const { t } = useTranslation();
  const target = targetOf(pin);
  const count = useQuery({
    queryKey: ["home-pin-count", pin.view_id, pin.filters],
    enabled: target.endpoint !== null,
    staleTime: 60_000,
    queryFn: () => api.get<CountedPage<unknown>>(target.endpoint!, { query: { ...(pin.filters as Record<string, unknown>), limit: 1 } }),
  });
  const n = count.data?.counts?.filtered;
  const watches = useViewWatches();
  const ops = useViewWatchOps();
  const watch = (watches.data ?? []).find((w) => w.view_id === pin.view_id);
  const [open, setOpen] = useState(false);
  const [min, setMin] = useState("10");
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!watch || n === undefined || reported.current === `${watch.min_rows}|${n}`) return;
    reported.current = `${watch.min_rows}|${n}`;
    void reportViewWatch(pin.view_id, n).catch(() => undefined);
  }, [watch, n, pin.view_id]);
  const minN = Number(min);
  const minOk = Number.isInteger(minN) && minN >= 1 && minN <= 100000;
  const inner = (
    <>
      <Pin size={12} aria-hidden className="mt-0.5 shrink-0 text-mute" />
      <span className="flex-1 truncate">{pin.name}</span>
      {target.endpoint !== null && (
        <span className="tnum text-sm font-semibold" data-testid={`pin-count-${pin.view_id}`}>
          {count.isLoading ? t("common.loading") : n === undefined ? t("dash.kpi.na") : n}
        </span>
      )}
    </>
  );
  const cls = "flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-hover focus-visible:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
  return (
    <li data-testid={`pin-row-${pin.view_id}`}>
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          {target.path ? (
            <Link className={cls} to={`${target.path}?view_id=${pin.view_id}`} data-testid={`pin-link-${pin.view_id}`}>{inner}</Link>
          ) : (
            <span className={cls}>{inner}</span>
          )}
        </div>
        {target.endpoint !== null && (
          <button
            type="button"
            className="rounded p-1.5 text-mute hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            title={watch ? t("dash.pins.watching", { n: watch.min_rows }) : t("dash.pins.watch_title")}
            aria-label={watch ? t("dash.pins.watching", { n: watch.min_rows }) : t("dash.pins.watch")}
            aria-expanded={open}
            data-testid={`pin-watch-${pin.view_id}`}
            onClick={() => { if (watch) setMin(String(watch.min_rows)); setOpen((x) => !x); }}
          >
            {watch ? <BellRing size={14} aria-hidden className="text-accent" /> : <Bell size={14} aria-hidden />}
          </button>
        )}
      </div>
      {open && (
        <form
          className="mx-2 mb-1 mt-0.5 flex flex-wrap items-end gap-2 rounded border border-line p-2 text-sm"
          data-testid={`pin-watch-form-${pin.view_id}`}
          onSubmit={(e) => { e.preventDefault(); if (minOk) ops.watch.mutate({ id: pin.view_id, min_rows: minN }, { onSuccess: () => { reported.current = null; setOpen(false); } }); }}
        >
          <label className="flex flex-col gap-0.5">
            <span className="text-xs text-mute">{t("dash.pins.min_rows")}</span>
            <input type="number" min={1} max={100000} step={1} className="w-24 rounded border border-line bg-surface px-2 py-1" value={min} onChange={(e) => setMin(e.target.value)} data-testid={`pin-watch-min-${pin.view_id}`} />
          </label>
          <button type="submit" className="rounded bg-accent px-2 py-1 text-sm text-white disabled:opacity-50" disabled={!minOk || ops.watch.isPending} data-testid={`pin-watch-save-${pin.view_id}`}>{t("dash.pins.save")}</button>
          {watch && (
            <button type="button" className="rounded border border-line px-2 py-1 text-sm hover:bg-hover" disabled={ops.unwatch.isPending} data-testid={`pin-watch-remove-${pin.view_id}`} onClick={() => ops.unwatch.mutate(pin.view_id, { onSuccess: () => setOpen(false) })}>{t("dash.pins.remove")}</button>
          )}
          <p className="w-full text-xs text-mute">{t("dash.pins.hint_alert")}</p>
        </form>
      )}
    </li>
  );
}

export function PinnedViewsCard() {
  const { t } = useTranslation();
  const pins = useHomePins();
  const items = pins.data ?? [];
  return (
    <Card title={t("dash.pins.title")} testid="dash-pinned-views" basisNote={t("dash.pins.hint")}>
      {pins.isLoading ? (
        <p className="text-mute" role="status" data-testid="dash-pins-loading">{t("common.loading")}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-mute" data-testid="dash-pins-empty">{t("dash.pins.empty")}</p>
      ) : (
        <ul className="space-y-0.5" data-testid="dash-pins-list">
          {items.map((p) => <PinRow key={p.view_id} pin={p} />)}
        </ul>
      )}
    </Card>
  );
}
