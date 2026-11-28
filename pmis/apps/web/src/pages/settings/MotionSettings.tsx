import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { celebrateOn, setCelebrate } from "@/lib/celebrate";
import { applyMotion, currentMotion, type MotionPref } from "@/lib/motion";

const CHOICES: MotionPref[] = ["auto", "reduced"];

/**
 * Settings, Screens, Motion (item 2): one motion system for the whole app (styles/motion.css). "Automatic" follows the operating system; "Reduced" turns every
 * transition and animation off, including the charts and the map pulse. Saved in this browser, like the theme and the language.
 */
export function MotionSettings() {
  const { t } = useTranslation();
  const [pref, setPref] = useState<MotionPref>(currentMotion);
  const [replay, setReplay] = useState(0);
  const [celebrate, setCel] = useState(celebrateOn);
  const choose = (p: MotionPref) => {
    applyMotion(p);
    setPref(p);
    setReplay((n) => n + 1);
  };
  return (
    <section className="card space-y-4 p-4" data-testid="page-motion-settings">
      <h2 className="font-bold">{t("motion.title")}</h2>
      <p className="text-sm text-mute">{t("motion.note")}</p>
      <fieldset className="space-y-2" data-testid="motion-choices">
        <legend className="sr-only">{t("motion.title")}</legend>
        {CHOICES.map((c) => (
          <label key={c} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="motion"
              className="mt-1"
              checked={pref === c}
              data-testid={`motion-${c}`}
              onChange={() => choose(c)}
            />
            <span>
              <b>{t(`motion.${c}`)}</b>
              <span className="block text-mute">{t(`motion.${c}_note`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={celebrate} data-testid="motion-celebrate" onChange={(e) => { setCelebrate(e.target.checked); setCel(e.target.checked); }} />
        <span><b>{t("motion.celebrate_label")}</b><span className="block text-mute">{t("motion.celebrate_note")}</span></span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <div
          key={replay}
          className="motion-pop card px-4 py-2 text-sm"
          data-testid="motion-preview"
        >
          {t("motion.preview")}
        </div>
        <button className="btn" data-testid="motion-replay" onClick={() => setReplay((n) => n + 1)}>
          {t("motion.replay")}
        </button>
      </div>
      <p className="text-sm">
        <Link className="text-accent hover:underline" to="/admin/settings/screens/tables" data-testid="motion-link-display">
          {t("motion.link_display")}
        </Link>
      </p>
    </section>
  );
}
