import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { applyLocale } from '@/i18n';
import { UnsavedGuardProvider, useUnsavedGuard } from './unsavedGuard';

// Decision 11: the shared guard. A dirty screen asks before an in-app link leaves it; Stay keeps it, Discard leaves, Save (with a reason) saves then leaves.
function Editor({ save }: { save: (reason: string) => void }) {
  const [dirty, setDirty] = useState(false);
  const nav = useNavigate();
  useUnsavedGuard({ scope: 'settings', dirty, needsReason: true, label: 'Test', onSave: (reason) => { save(reason); return true; } });
  return <div><input data-testid="field" onChange={() => setDirty(true)} /><button data-testid="go" onClick={() => nav('/other')}>go</button></div>;
}

function setup(save = vi.fn()) {
  applyLocale('en');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={['/edit']}><UnsavedGuardProvider>
      <Routes><Route path="/edit" element={<Editor save={save} />} /><Route path="/other" element={<p data-testid="other">other</p>} /></Routes>
    </UnsavedGuardProvider></MemoryRouter></QueryClientProvider>,
  );
  return save;
}

describe('unsaved guard', () => {
  it('lets a clean screen go without asking', async () => {
    setup();
    await userEvent.click(screen.getByTestId('go'));
    expect(await screen.findByTestId('other')).toBeInTheDocument();
    expect(screen.queryByTestId('unsaved-dialog')).toBeNull();
  });
  it('asks when dirty: Stay keeps the screen, Discard leaves', async () => {
    setup();
    fireEvent.change(screen.getByTestId('field'), { target: { value: 'x' } });
    await userEvent.click(screen.getByTestId('go'));
    expect(await screen.findByTestId('unsaved-dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('unsaved-stay'));
    expect(screen.queryByTestId('unsaved-dialog')).toBeNull();
    expect(screen.queryByTestId('other')).toBeNull();
    await userEvent.click(screen.getByTestId('go'));
    await userEvent.click(await screen.findByTestId('unsaved-discard'));
    expect(await screen.findByTestId('other')).toBeInTheDocument();
  });
  it('Save needs a reason of 3 characters, saves with it, then leaves', async () => {
    const save = setup();
    fireEvent.change(screen.getByTestId('field'), { target: { value: 'x' } });
    await userEvent.click(screen.getByTestId('go'));
    const btn = await screen.findByTestId('unsaved-save');
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByTestId('unsaved-reason'), 'ok');
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByTestId('unsaved-reason'), 'ay');
    await userEvent.click(btn);
    await waitFor(() => expect(save).toHaveBeenCalledWith('okay'));
    expect(await screen.findByTestId('other')).toBeInTheDocument();
  });
});
