import { useEffect, useState } from 'react';
import { useUiFeatures, type UiFeatures } from './uiFeatures';
import { disableFieldWorker, enableFieldWorker } from '@/lib/fieldPwa';

/** Contract 0.15.340 (migration 0411): Field mode, a section of the interface features (Settings > Screens > Field mode). Off by default. */
export type UiFieldPwa = UiFeatures['field_pwa'];
export const FIELD_PWA_SEED: UiFieldPwa = { enabled: false, cache_hours: 24, max_queue: 50, max_photo_mb: 8, sync_seconds: 60 };

export function useFieldPwaSettings(): UiFieldPwa {
  const d = useUiFeatures().field_pwa as Partial<UiFieldPwa> | undefined;
  return { ...FIELD_PWA_SEED, ...d };
}

/** Registers the worker while the switch is on and removes it when it goes off (the shell cache goes with it). */
export function useFieldWorker(enabled: boolean) {
  useEffect(() => { void (enabled ? enableFieldWorker() : disableFieldWorker()); }, [enabled]);
}

/** navigator.onLine with its events: the browser's own signal; a failed request is still what decides (see fieldSync). */
export function useOnline(): boolean {
  const [on, setOn] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOn(true), down = () => setOn(false);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return on;
}
