import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { Companies } from './Companies';
import { renderApp } from '@/test/utils';

const view = (route: string) => renderApp(<Routes><Route path="/companies" element={<Companies />} /></Routes>, { route });

describe('Companies page', () => {
  it('opens on the list and switches tabs through the URL', async () => {
    view('/companies');
    expect(await screen.findByTestId('companies-tabs')).toBeInTheDocument();
    expect(screen.getByTestId('companies-tab-list')).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByTestId('companies-tab-ranking'));
    expect(screen.getByTestId('companies-tab-ranking')).toHaveAttribute('aria-selected', 'true');
  });
  it('opens a tab from the link and falls back to the list for an unknown tab', async () => {
    view('/companies?tab=match');
    expect(await screen.findByTestId('companies-tab-match')).toHaveAttribute('aria-selected', 'true');
    view('/companies?tab=zzz');
    expect((await screen.findAllByTestId('companies-tab-list'))[1]).toHaveAttribute('aria-selected', 'true');
  });
});
