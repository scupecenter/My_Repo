/** Workload heat: 0 (none) to 4 (highest) for a person's open count against the busiest person shown. */
export function heatLevel(open: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (open <= 0 || max <= 0) return 0;
  const r = open / max;
  return r > 0.75 ? 4 : r > 0.5 ? 3 : r > 0.25 ? 2 : 1;
}
