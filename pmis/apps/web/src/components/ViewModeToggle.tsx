import { useTranslation } from 'react-i18next';

export type ViewMode = "vertical" | "grid";

/**
 * Vertical (the row list) / Grid (the spreadsheet-like table) switch (F16). It is a plain two-button group with aria-pressed, so it works on
 * any list screen; the caller keeps the choice (the registers keep it in the URL, like their filters).
 */
export function ViewModeToggle({
  value,
  onChange,
  testid = "view-mode",
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
  testid?: string;
}) {
  const { t } = useTranslation();
  const options: { v: ViewMode; label: string }[] = [
    { v: "vertical", label: t("viewMode.vertical") },
    { v: "grid", label: t("viewMode.grid") },
  ];
  return (
    <div
      className="flex gap-1"
      role="group"
      aria-label={t("viewMode.label")}
      data-testid={testid}
    >
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          className={`btn ${value === o.v ? "btn-accent" : ""}`}
          aria-pressed={value === o.v}
          data-testid={`${testid}-${o.v}`}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
