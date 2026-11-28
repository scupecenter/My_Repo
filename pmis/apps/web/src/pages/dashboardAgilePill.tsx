/** A figure chip of the agile views with a hover hint (every chip explains itself). */
export function Pill({ label, value, hint, testid }: { label: string; value: string; hint: string; testid: string }) {
  return (
    <span className="card px-3 py-1.5 text-sm" title={hint} data-testid={testid}>
      {label} <b className="tnum">{value}</b>
    </span>
  );
}
