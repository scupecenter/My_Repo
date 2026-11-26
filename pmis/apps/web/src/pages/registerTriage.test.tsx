import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { api } from '@/api/client';
import { recId } from '@/mocks/registersData';
import { renderApp, signIn } from '@/test/utils';
import { RegisterPage } from './Register';

const Routed = () => (
  <Routes>
    <Route path="/registers/:key" element={<RegisterPage />} />
  </Routes>
);

/** 0.15.100: intake triage of the Issue Log and the Change Control Log (accept / reject / merge as a duplicate / defer). */
describe('Register intake triage (0.15.100)', () => {
  it('a pending record shows its queue chip in the list and is accepted from the drawer', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/registers/issues' });
    expect(await screen.findByTestId(`reg-triage-${recId(18)}`)).toHaveTextContent('Waiting for intake review');
    expect(screen.getByTestId(`reg-triage-${recId(19)}`)).toHaveTextContent('Deferred at intake');
    const u = userEvent.setup();
    await u.click(screen.getByTestId(`reg-row-${recId(18)}`));
    expect(await screen.findByTestId('reg-triage-state')).toHaveTextContent('Waiting for intake review');
    await u.click(screen.getByTestId('triage-accept'));
    await waitFor(() => expect(screen.getByTestId('reg-triage-state')).toHaveTextContent('Accepted at intake'));
    expect(screen.getByTestId('reg-triage-by')).toBeInTheDocument();
  });

  it('defer asks for an optional note and keeps the record in the queue', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: `/registers/issues?record=${recId(18)}` });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('triage-defer'));
    await u.type(await screen.findByTestId('triage-note'), 'Check with the contractor first');
    await u.click(screen.getByTestId('triage-send'));
    await waitFor(() => expect(screen.getByTestId('reg-triage-state')).toHaveTextContent('Deferred at intake'));
    expect(screen.getByTestId('reg-triage-note')).toHaveTextContent('Check with the contractor first');
  });

  it('merge needs the surviving record and a note, then the record is voided as a duplicate', async () => {
    await signIn('pm');
    await api.post('/__mock/step-up');
    renderApp(<Routed />, { route: `/registers/issues?record=${recId(18)}` });
    const u = userEvent.setup();
    await u.click(await screen.findByTestId('triage-merge'));
    await u.click(await screen.findByTestId('triage-send'));
    expect(await screen.findByTestId('triage-error')).toBeInTheDocument();
    await u.selectOptions(screen.getByTestId('triage-dup'), recId(20));
    await u.type(screen.getByTestId('triage-note'), 'Same fence issue as the other site');
    await u.click(screen.getByTestId('triage-send'));
    await waitFor(() => expect(screen.getByTestId('reg-triage-state')).toHaveTextContent('Merged as a duplicate'));
    expect(screen.getByTestId('reg-state')).toHaveTextContent('Voided');
    expect(screen.getByTestId('reg-triage-dup')).toBeInTheDocument();
  });

  it('the intake-state filter lists only the records waiting in the queue', async () => {
    await signIn('pm');
    renderApp(<Routed />, { route: '/registers/issues?triage=pending' });
    expect(await screen.findByTestId(`reg-row-${recId(18)}`)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId(`reg-row-${recId(20)}`)).not.toBeInTheDocument());
  });
});
