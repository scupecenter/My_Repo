/**
 * Colours of the progress figures (contract 0.15.432, settings review gap 5): the SPI, the progress against plan in points and the weekly velocity.
 * Higher is better for all three. A figure has a colour only when an admin turned it on and saved it in Settings > Dashboard (`enabled`); otherwise null,
 * which keeps the figure exactly as it was before the setting existed.
 */
export type RagCode = "spi" | "progress_gap" | "velocity";
export interface RagItem {
  code: string;
  enabled: boolean;
  green: number;
  amber: number;
}
export type RagTone = "green" | "amber" | "red";

export function ragTone(
  items: readonly RagItem[] | undefined,
  code: RagCode,
  value: number | null | undefined,
): RagTone | null {
  const it = items?.find((i) => i.code === code);
  if (!it || !it.enabled || value === null || value === undefined || Number.isNaN(value)) return null;
  if (value >= it.green) return "green";
  if (value >= it.amber) return "amber";
  return "red";
}

/** The chip classes of a tone (the same classes as the dashboard counters); an empty string for no colour. */
export const RAG_CLASS: Record<RagTone, string> = {
  green: "bg-doneBg text-doneInk",
  amber: "bg-waitBg text-waitInk",
  red: "bg-lateBg text-lateInk",
};
