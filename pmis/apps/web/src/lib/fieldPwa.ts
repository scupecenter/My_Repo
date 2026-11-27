import { wipeFieldDatabases } from './fieldOutbox';

/**
 * Registers the Field mode service worker while the setting is on, and removes it (with its cache and the queue on this device) when it is off or when the
 * person signs out. The worker is not used in the mock build (the mock worker owns the scope there) nor in tests.
 */
const canUse = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && import.meta.env.PROD && import.meta.env.VITE_USE_MOCKS !== 'true';

export async function enableFieldWorker(): Promise<boolean> {
  if (!canUse()) return false;
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    return true;
  } catch {
    return false;
  }
}

/** Setting turned off: unregister the worker and drop its cache. The queue of actions is NOT touched here (it may hold work not sent yet); only sign-out wipes it. */
export async function disableFieldWorker(): Promise<void> {
  if (!canUse()) return;
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map((r) => r.active?.scriptURL.endsWith('/sw.js') ? (r.active.postMessage({ type: 'wipe' }), r.unregister()) : Promise.resolve(false)));
}

/** Sign-out and change of user: the shell cache and every field database of this device go. */
export async function wipeFieldData(): Promise<void> {
  await disableFieldWorker().catch(() => undefined);
  await wipeFieldDatabases().catch(() => undefined);
}
