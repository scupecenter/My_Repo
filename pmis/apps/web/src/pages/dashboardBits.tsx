import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * The shared card primitives of the dashboard (extracted from Dashboard.tsx unchanged, 0.15.96), so the follow-up
 * cards (dashboardOps.tsx) use the same design system: card, progress bar, KPI tile and the percentage format.
 */

export const pct = (n: number | null | undefined, digits = 1): string =>
  n === null || n === undefined ? "–" : `${Number(n.toFixed(digits))}%`;
export const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

export function Card({
  title,
  testid,
  children,
  aside,
  className = "",
}: {
  title: string;
  testid: string;
  children: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`card p-4 ${className}`}
      data-testid={testid}
      aria-label={title}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A progress bar with an optional tick for the plan. */
export function Bar({
  value,
  plan,
  tone = "bg-accent",
}: {
  value: number;
  plan?: number | null;
  tone?: string;
}) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      className="relative h-3 w-full rounded-full bg-lockBg"
      role="progressbar"
      aria-valuenow={Math.round(v)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <i
        className={`absolute inset-y-0 start-0 rounded-full ${tone}`}
        style={{ width: `${v}%` }}
      />
      {plan !== null && plan !== undefined && (
        <u
          className="absolute -inset-y-1 border-s-2 border-dashed border-ink no-underline"
          style={{ insetInlineStart: `${Math.max(0, Math.min(100, plan))}%` }}
          aria-hidden
        />
      )}
    </div>
  );
}

export function Kpi({
  title,
  value,
  sub,
  to,
  testid,
  tone,
}: {
  title: string;
  value: ReactNode;
  sub?: ReactNode;
  to?: string;
  testid: string;
  tone?: string;
}) {
  const body = (
    <>
      <div className="text-sm text-mute">{title}</div>
      <div className={`text-3xl font-bold tnum ${tone ?? ""}`}>{value}</div>
      {sub && <div className="mt-1 text-sm text-mute">{sub}</div>}
    </>
  );
  return to ? (
    <Link
      to={to}
      className="card block p-4 transition-transform hover:-translate-y-0.5 hover:border-mute"
      data-testid={testid}
    >
      {body}
    </Link>
  ) : (
    <div className="card p-4" data-testid={testid}>
      {body}
    </div>
  );
}
