import { ArrowRight, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** The arrow between the two ends of a path ("A1 to A2"): it points the way the text reads, so it is turned round in Arabic. Plain text for sentences that carry a path. */
export function useArrow(): string {
  const { i18n } = useTranslation();
  return i18n.dir() === 'rtl' ? ' ← ' : ' → ';
}

/** A code, a number or a percentage inside text of either direction: it keeps its own left-to-right order. */
export const Code = ({ children, className = 'mono', testid }: { children: ReactNode; className?: string; testid?: string }) => <bdi dir="ltr" className={className} data-testid={testid}>{children}</bdi>;

/** A name typed by a person: it takes the direction of its own letters, whatever the page direction is. */
export const Name = ({ children }: { children: ReactNode }) => <bdi>{children}</bdi>;

/** A chevron that points to the end of the line (right in English, left in Arabic). */
export const Chev = ({ size = 12, className = '' }: { size?: number; className?: string }) => <ChevronRight size={size} aria-hidden className={`shrink-0 rtl:rotate-180 ${className}`} />;

/** "from to to": the arrow is drawn, not typed, so it can turn round. */
export const Flow = ({ from, to, ltr = false }: { from: ReactNode; to: ReactNode; ltr?: boolean }) => {
  const Part = ltr ? Code : Name;
  return <span className="inline-flex flex-wrap items-center gap-1"><Part>{from}</Part><ArrowRight size={12} aria-hidden className="shrink-0 rtl:rotate-180" /><Part>{to}</Part></span>;
};

/** A code placed inside a translated sentence (an interpolation cannot carry a tag): isolated left to right so Arabic text around it cannot reorder it. */
export const ltr = (code: string | number): string => `⁦${code}⁩`;
