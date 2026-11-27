import { useQuery } from "@tanstack/react-query";
import { Pin } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api } from "@/api/client";
import type { CountedPage } from "@/api/types";
import { useHomePins, type HomeViewPin } from "@/api/views";
import { Card } from "./dashboardBits";

/**
 * Pinned views (contract 0.15.245, migration 0344; owner request 2026-11-27, item 16 of the 2026-11-27 batch). The caller's pinned saved views as one card, ordered and hidden per tab from Settings > Dashboard like every other card.
 * Personal: the pins are the caller's own (GET /me/home-pins). The counter of a pin is the screen's own list endpoint called with the view's
 * filters and limit 1, so the count is exactly what the caller may see there; the counter is shown for the sites and register screens. A pin
 * opens its screen with the view applied (?view_id).
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
      {target.path ? (
        <Link className={cls} to={`${target.path}?view_id=${pin.view_id}`} data-testid={`pin-link-${pin.view_id}`}>{inner}</Link>
      ) : (
        <span className={cls}>{inner}</span>
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
