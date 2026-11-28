import { ApiError, api } from '@/api/client';
import type { FieldAction, FieldStore } from './fieldOutbox';

/**
 * Sends the queue of Field mode in order (contract 0.15.340). The rules, in one place:
 *  - network failure or 5xx: stop, the action keeps waiting (retried on the next sync; after MAX_TRIES it needs attention);
 *  - 401: stop, the person signs in again and the queue goes on;
 *  - 403, 404, 409, 412, 413, 422: the server said no (rights changed, snag gone, rule broken): the action needs attention with the server's words, it is
 *    never retried by itself and never overwrites anything;
 *  - a submit is sent only if the snag is still "fix_submitted" on the server when it is its turn: if someone else already submitted or closed it, the action is
 *    done with a note; if photos are still missing, it needs attention;
 *  - when an action of a snag needs attention, the later actions of the same snag need attention too (earlier_failed), so nothing is sent out of order.
 */
export const MAX_TRIES = 5;

export type SendOutcome =
  | { kind: 'ok' }
  | { kind: 'skip'; note: string }                   // nothing to do any more: the server state already is what the person wanted
  | { kind: 'refused'; reason: string; message: string }
  | { kind: 'retry' }                                // network or server trouble
  | { kind: 'auth' };

export type Sender = (a: FieldAction) => Promise<SendOutcome>;

export interface SyncResult { sent: number; attention: number; stopped: 'offline' | 'auth' | null }

export async function syncOutbox(store: FieldStore, send: Sender): Promise<SyncResult> {
  const res: SyncResult = { sent: 0, attention: 0, stopped: null };
  const all = await store.list();
  const blocked = new Set<string>(all.filter((a) => a.state === 'attention').map((a) => a.snagId));
  for (const a of all) {
    if (a.state !== 'waiting') continue;
    if (blocked.has(a.snagId)) {
      await store.put({ ...a, state: 'attention', reason: 'earlier_failed', message: undefined });
      res.attention++;
      continue;
    }
    const out = await send(a);
    if (out.kind === 'ok' || out.kind === 'skip') {
      await store.put({ ...a, state: 'done', blob: undefined, signature: undefined, reason: undefined, message: out.kind === 'skip' ? out.note : undefined });
      res.sent++;
    } else if (out.kind === 'refused') {
      await store.put({ ...a, state: 'attention', reason: out.reason, message: out.message });
      blocked.add(a.snagId);
      res.attention++;
    } else if (out.kind === 'auth') {
      res.stopped = 'auth';
      return res;
    } else {
      const tries = a.tries + 1;
      if (tries >= MAX_TRIES) {
        await store.put({ ...a, tries, state: 'attention', reason: 'retries_exhausted' });
        blocked.add(a.snagId);
        res.attention++;
      } else {
        await store.put({ ...a, tries });
        res.stopped = 'offline';
        return res;
      }
    }
  }
  return res;
}

const REFUSED = new Set([403, 404, 409, 412, 413, 422]);

/** The real sender: the same endpoints the Quality screen uses, with the action id as Idempotency-Key. */
export const apiSender: Sender = async (a) => {
  try {
    if (a.kind === 'form_submit') {
      if (!a.siteId || !a.formCode) return { kind: 'skip', note: 'no form' };
      await api.post(`/sites/${a.siteId}/field-forms`, { body: { client_id: a.id, form_code: a.formCode, answers: a.answers ?? {}, signature: a.signature ?? null, signer_name: a.signerName ?? null, captured_at: a.capturedAt ?? a.createdAt }, idempotencyKey: a.id });
      return { kind: 'ok' };
    }
    if (a.kind === 'snag_photo') {
      if (!a.blob) return { kind: 'skip', note: 'no file' };
      const f = new FormData();
      f.append('file', a.blob, a.fileName ?? 'photo.jpg');
      if (a.shotType) f.append('shot_type', a.shotType);
      if (a.lat != null && a.lon != null) { f.append('device_lat', String(a.lat)); f.append('device_lon', String(a.lon)); }
      if (a.inAppCamera) f.append('in_app_camera', 'true');
      await api.post(`/snags/${a.snagId}/photos`, { body: f, idempotencyKey: a.id });
      return { kind: 'ok' };
    }
    const snag = await api.get<{ state: string; version: number }>(`/snags/${a.snagId}`);
    if (snag.state === 'in_review' || snag.state === 'closed') return { kind: 'skip', note: snag.state };
    if (snag.state === 'cancelled') return { kind: 'refused', reason: 'already_changed', message: snag.state };
    if (snag.state !== 'fix_submitted') return { kind: 'refused', reason: 'photos_missing', message: snag.state };
    await api.post(`/snags/${a.snagId}/submit`, { version: snag.version, idempotencyKey: a.id });
    return { kind: 'ok' };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 401) return { kind: 'auth' };
      if (REFUSED.has(e.status)) return { kind: 'refused', reason: String(e.problem.code ?? e.status), message: e.problem.detail ?? e.problem.title ?? '' };
      return { kind: 'retry' };
    }
    return { kind: 'retry' };
  }
};
