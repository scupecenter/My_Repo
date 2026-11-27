import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import en from '@/i18n/en.json';
import ar from '@/i18n/ar.json';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from '@/pages/Register';
import { EditingNotice } from './EditingNotice';

/** 0.15.246 (migration 0345, item 17): the soft "… is editing this record" notice in the register record editor. */
const firstRecord = async () => {
  const list = await api.get<{ items: { id: string }[] }>('/registers/procurement/records', { query: { limit: 1 } });
  return list.items[0]!.id;
};

describe('Editing notice (0.15.246, item 17)', () => {
  it('shows the other editors by name, never the caller; the caller’s own heartbeat starts in the editor', async () => {
    await signIn('pm');
    const id = await firstRecord();

    // No other editor yet: the editor starts the caller's heartbeat but shows no notice.
    renderApp(<Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>, { route: `/registers/procurement?record=${id}` });
    await screen.findByTestId('reg-close');
    await waitFor(async () => {
      expect((await api.get<{ editors: unknown[] }>('/presence/editing', { query: { kind: 'record', entity_id: id } })).editors).toEqual([]);
    });
    expect(screen.queryByTestId('reg-editing-notice')).not.toBeInTheDocument();

    // A colleague (the reviewer) pings: the notice names them.
    await signIn('reviewer');
    await api.post('/presence/editing', { body: { kind: 'record', entity_id: id } });
    await signIn('pm');
    // Direct read: the colleague is listed for the caller.
    const direct = await api.get<{ editors: { display_name: string }[] }>('/presence/editing', { query: { kind: 'record', entity_id: id } });
    expect(direct.editors.map((e) => e.display_name)).toEqual(['Demo User 02']);
    renderApp(<Routes><Route path="/registers/:key" element={<RegisterPage />} /></Routes>, { route: `/registers/procurement?record=${id}` });
    const notice = await screen.findByTestId('reg-editing-notice', undefined, { timeout: 10_000 });
    expect(notice).toHaveTextContent('Demo User 02');
    expect(notice).toHaveTextContent('is editing this record');
  }, 30_000);

  it('shows the notice on a task record too (kind task; the feature covers every record screen)', async () => {
    const TASK = '66666666-7777-4888-8999-000000000777';
    await signIn('reviewer');
    await api.post('/presence/editing', { body: { kind: 'task', entity_id: TASK } });
    await signIn('pm');
    renderApp(<EditingNotice kind="task" id={TASK} editing testid="task-editing-notice" />);
    const notice = await screen.findByTestId('task-editing-notice', undefined, { timeout: 10_000 });
    expect(notice).toHaveTextContent('Demo User 02');
    expect(notice).toHaveTextContent('is editing this task');
  }, 30_000);

  it('has the same presence.editing_ keys in English and Arabic', () => {
    const keys = (d: unknown) => Object.keys((d as Record<string, Record<string, unknown>>).presence).filter((k) => k.startsWith('editing_')).sort();
    expect(keys(ar)).toEqual(keys(en));
  });
});
