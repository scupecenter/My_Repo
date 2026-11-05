import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, ApiError } from '@/api/client';
import { resetQcMocks, siteProposals } from '@/mocks/handlers.qc';
import { siteIdOf } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';
import { Site } from './Site';

/**
 * Technical decision Q473 (contract 0.14.1): the identity of a site changes only through a Change Control proposal. The site page offers "Propose a change" for the names
 * and the coordinates (the same proposal as the Q225 switch, with a reason); region and cluster appear only to a System Admin; the Site ID is shown and never offered.
 * The mock site 2 is in WM (region 3) with the cluster CL-WM-3.
 */
const SITE = siteIdOf(2);
const SiteAt = () => <Routes><Route path="/sites/:siteId" element={<Site />} /></Routes>;

beforeEach(() => resetQcMocks());
afterEach(() => cleanup());

const open = async (u: ReturnType<typeof userEvent.setup>) => { await u.click(await screen.findByTestId('site-identity-open')); return screen.findByTestId('site-identity-form'); };
const refused = async (identity: Record<string, unknown>): Promise<ApiError> => {
  try { await api.post(`/sites/${SITE}/change-proposals`, { body: { identity, reason: 'test' } }); } catch (e) { return e as ApiError; }
  throw new Error('expected a refusal');
};

describe('Q473: Propose a change on the site page', () => {
  it('shows the Site ID as never changing and proposes the names and the coordinates with a reason; the site keeps its values', async () => {
    await signIn('engineer');
    const u = userEvent.setup();
    renderApp(<SiteAt />, { route: `/sites/${SITE}` });
    const box = await screen.findByTestId('site-identity');
    expect(within(box).getByTestId('site-identity-site-code')).toHaveTextContent('WM103');
    expect(within(box).getByTestId('site-identity-immutable')).toHaveTextContent('Never changes');
    const form = await open(u);
    // nothing to send yet, and no region or cluster field for somebody who is not a System Admin
    expect(within(form).getByTestId('site-identity-send')).toBeDisabled();
    expect(within(form).queryByTestId('site-identity-region_id')).toBeNull();
    expect(within(form).queryByTestId('site-identity-cluster_code')).toBeNull();
    expect(within(form).getByTestId('site-identity-note')).not.toHaveTextContent('System Admin approves');
    const name = within(form).getByTestId('site-identity-name');
    await u.clear(name);
    await u.type(name, 'Corrected name');
    const nameAr = within(form).getByTestId('site-identity-name_ar');
    await u.clear(nameAr);
    await u.type(nameAr, 'اسم مصحح');
    await u.type(within(form).getByTestId('site-identity-latitude'), '32.887');
    expect(within(form).getByTestId('site-identity-send')).toBeDisabled();                  // a reason is required
    await u.type(within(form).getByTestId('site-identity-reason'), 'spelling in the Master');
    await u.click(within(form).getByTestId('site-identity-send'));
    // latitude without longitude: the database says the pair is required, next to the field
    expect(await screen.findByTestId('site-identity-error-longitude')).toHaveTextContent('Latitude and longitude go together.');
    expect(siteProposals).toHaveLength(0);                                                   // nothing is proposed when one field is refused
    await u.type(within(form).getByTestId('site-identity-longitude'), '13.191');
    await u.click(within(form).getByTestId('site-identity-send'));
    expect(await screen.findByText(/3 proposal\(s\) created in Change Control/)).toBeInTheDocument();
    expect(siteProposals.map((p) => [p.field, p.new_value])).toEqual([['name', 'Corrected name'], ['name_ar', 'اسم مصحح'], ['coordinates', '32.887000, 13.191000']]);
    expect(siteProposals.every((p) => p.site_id === SITE && p.reason === 'spelling in the Master')).toBe(true);
    await waitFor(() => expect(screen.queryByTestId('site-identity-form')).toBeNull());
    expect(screen.getByTestId('site-title')).not.toHaveTextContent('Corrected name');          // the site keeps its approved values until L2 decides
  });

  it('shows region and cluster to a System Admin only; a region change that leaves the old cluster behind is refused next to the cluster field', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<SiteAt />, { route: `/sites/${SITE}` });
    const form = await open(u);
    expect(within(form).getByTestId('site-identity-note')).toHaveTextContent('System Admin approves');
    const region = within(form).getByTestId('site-identity-region_id') as HTMLSelectElement;
    expect(region.value).toBe('3');
    await u.selectOptions(region, '5');
    expect(await within(form).findByTestId('site-identity-move')).toHaveTextContent('moves from');
    await u.type(within(form).getByTestId('site-identity-reason'), 'the Master lists it in Benghazi');
    await u.click(within(form).getByTestId('site-identity-send'));
    expect(await screen.findByTestId('site-identity-error-cluster_code')).toHaveTextContent('belongs to another region');
    expect(siteProposals).toHaveLength(0);
    const cluster = within(form).getByTestId('site-identity-cluster_code');
    await u.clear(cluster);
    await u.type(cluster, 'CL-BG-1');
    await u.click(within(form).getByTestId('site-identity-send'));
    expect(await screen.findByText(/1 proposal\(s\) created/)).toBeInTheDocument();
    expect(siteProposals).toEqual([expect.objectContaining({ site_id: SITE, field: 'region', old_value: 'WM / CL-WM-3', new_value: 'BG / CL-BG-1' })]);
  });

  it('offers nothing to somebody who can only view; the mock refuses a region proposal from a non-admin with 403 and the Site ID with immutable', async () => {
    await signIn('auditor');
    renderApp(<SiteAt />, { route: `/sites/${SITE}` });
    await screen.findByTestId('site-title');
    expect(screen.queryByTestId('site-identity')).toBeNull();
    cleanup();
    await signIn('engineer');
    const err = await refused({ region_id: 5 });
    expect(err.status).toBe(403);
    expect(err.code).toBe('action_forbidden');
    const err2 = await refused({ cluster_code: 'CL-WM-1' });
    expect(err2.status).toBe(403);
    const id = await refused({ site_code: 'XX999' });
    expect(id.status).toBe(422);
    expect(id.problem.errors).toEqual([expect.objectContaining({ path: '/identity/site_code', code: 'immutable' })]);
    expect(siteProposals).toHaveLength(0);
    // a System Admin gets the same field error for the Site ID
    await signIn('pm');
    expect(((await refused({ site_code: 'XX999' })).problem.errors ?? [])[0]).toMatchObject({ code: 'immutable' });
  });

  it('is in Arabic in the Arabic interface, with the name field right to left', async () => {
    await signIn('pm');
    const u = userEvent.setup();
    renderApp(<SiteAt />, { route: `/sites/${SITE}`, locale: 'ar' });
    const box = await screen.findByTestId('site-identity');
    expect(box).toHaveTextContent('هوية الموقع');
    expect(within(box).getByTestId('site-identity-immutable')).toHaveTextContent('لا يتغيّر أبدًا');
    const form = await open(u);
    expect(form).toHaveTextContent('الاسم بالعربية');
    expect(form).toHaveTextContent('المنطقة');
    expect(within(form).getByTestId('site-identity-name_ar')).toHaveAttribute('dir', 'rtl');
    expect(within(form).getByTestId('site-identity-send')).toHaveTextContent('اقترح التغيير');
  });
});
