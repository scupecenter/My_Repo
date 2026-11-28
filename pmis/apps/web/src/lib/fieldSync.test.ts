import { describe, expect, it } from 'vitest';
import { enqueue, memoryStore, type FieldAction } from './fieldOutbox';
import { MAX_TRIES, syncOutbox, type SendOutcome } from './fieldSync';

const LIM = { max_queue: 5, max_photo_mb: 1 };
const photo = (snagId: string): Omit<FieldAction, 'id' | 'createdAt' | 'state' | 'tries'> => ({ kind: 'snag_photo', snagId, snagLabel: snagId, blob: new Blob(['x']), fileName: 'a.jpg' });
const submit = (snagId: string): Omit<FieldAction, 'id' | 'createdAt' | 'state' | 'tries'> => ({ kind: 'snag_submit', snagId, snagLabel: snagId });
let n = 0;
const tick = () => new Date(Date.UTC(2026, 10, 27, 10, 0, n++));

describe('field outbox limits', () => {
  it('refuses past the queue size and an oversize photo', async () => {
    const s = memoryStore();
    for (let i = 0; i < 5; i++) expect((await enqueue(s, submit(`s${i}`), LIM, tick)).ok).toBe(true);
    expect(await enqueue(s, submit('s9'), LIM, tick)).toEqual({ ok: false, reason: 'queue_full' });
    const s2 = memoryStore();
    const big = { ...photo('s1'), blob: new Blob([new Uint8Array(1024 * 1024 + 1)]) };
    expect(await enqueue(s2, big, LIM, tick)).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('field sync rules', () => {
  it('sends in order and drops the photo bytes once sent', async () => {
    const s = memoryStore();
    await enqueue(s, photo('a'), LIM, tick); await enqueue(s, submit('a'), LIM, tick);
    const seen: string[] = [];
    const r = await syncOutbox(s, async (a) => { seen.push(a.kind); return { kind: 'ok' }; });
    expect(seen).toEqual(['snag_photo', 'snag_submit']);
    expect(r).toEqual({ sent: 2, attention: 0, stopped: null });
    const left = await s.list();
    expect(left.every((x) => x.state === 'done' && !x.blob)).toBe(true);
  });

  it('stops on a network failure and keeps everything waiting; goes on later', async () => {
    const s = memoryStore();
    await enqueue(s, photo('a'), LIM, tick); await enqueue(s, photo('b'), LIM, tick);
    const r = await syncOutbox(s, async () => ({ kind: 'retry' }));
    expect(r.stopped).toBe('offline');
    const l = await s.list();
    expect(l.map((x) => [x.state, x.tries])).toEqual([['waiting', 1], ['waiting', 0]]);
    const r2 = await syncOutbox(s, async () => ({ kind: 'ok' }));
    expect(r2.sent).toBe(2);
  });

  it('a refusal needs attention, keeps the server words and holds the later actions of the same snag only', async () => {
    const s = memoryStore();
    await enqueue(s, photo('a'), LIM, tick); await enqueue(s, submit('a'), LIM, tick); await enqueue(s, photo('b'), LIM, tick);
    const send = async (a: FieldAction): Promise<SendOutcome> => (a.snagId === 'a' && a.kind === 'snag_photo' ? { kind: 'refused', reason: 'file_rejected', message: 'before the snag was raised' } : { kind: 'ok' });
    const r = await syncOutbox(s, send);
    expect(r).toEqual({ sent: 1, attention: 2, stopped: null });
    const l = await s.list();
    expect(l.find((x) => x.kind === 'snag_photo' && x.snagId === 'a')).toMatchObject({ state: 'attention', reason: 'file_rejected', message: 'before the snag was raised' });
    expect(l.find((x) => x.kind === 'snag_submit')).toMatchObject({ state: 'attention', reason: 'earlier_failed' });
    expect(l.find((x) => x.snagId === 'b')).toMatchObject({ state: 'done' });
  });

  it('a sign-in required stops the run without changing the queue', async () => {
    const s = memoryStore();
    await enqueue(s, photo('a'), LIM, tick);
    const r = await syncOutbox(s, async () => ({ kind: 'auth' }));
    expect(r.stopped).toBe('auth');
    expect((await s.list())[0]).toMatchObject({ state: 'waiting', tries: 0 });
  });

  it('after the retry limit the action needs attention', async () => {
    const s = memoryStore();
    await enqueue(s, photo('a'), LIM, tick);
    for (let i = 0; i < MAX_TRIES; i++) await syncOutbox(s, async () => ({ kind: 'retry' }));
    expect((await s.list())[0]).toMatchObject({ state: 'attention', reason: 'retries_exhausted' });
  });

  it('a submit the server already has is done with a note, not an error', async () => {
    const s = memoryStore();
    await enqueue(s, submit('a'), LIM, tick);
    const r = await syncOutbox(s, async () => ({ kind: 'skip', note: 'in_review' }));
    expect(r.sent).toBe(1);
    expect((await s.list())[0]).toMatchObject({ state: 'done', message: 'in_review' });
  });
});

import { snapshotFresh } from './fieldOutbox';
describe('field snapshots', () => {
  it('keep a read for the cache hours of the setting and no longer', async () => {
    const s = memoryStore();
    await s.putSnapshot('my-tasks', { items: [] }, new Date('2026-11-27T08:00:00Z'));
    const snap = await s.getSnapshot('my-tasks');
    expect(snapshotFresh(snap, 24, new Date('2026-11-28T07:59:00Z'))).toBe(true);
    expect(snapshotFresh(snap, 24, new Date('2026-11-28T08:01:00Z'))).toBe(false);
    expect(snapshotFresh(null, 24)).toBe(false);
    await s.clear();
    expect(await s.getSnapshot('my-tasks')).toBeNull();
  });
});
