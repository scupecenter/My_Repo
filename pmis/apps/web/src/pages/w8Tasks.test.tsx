import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { server } from '@/mocks/server';
import { siteIdOf, taskIdOf } from '@/mocks/sites';
import { renderApp, signIn } from '@/test/utils';
import { Route, Routes } from 'react-router-dom';
import { Site } from './Site';

/** W8 item 3: the site Tasks table opens as a list like the Site Master lists, with the shared toolbar; the Timeline is the second option. */
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
const SITE = siteIdOf(0), A1 = taskIdOf(0, 0);
const SiteAt = () => <Routes><Route path="/sites/:siteId" element={<Site />} /></Routes>;

describe('W8 site task list', () => {
  it('opens as a list: #, Code, Task, Status, Plan, Actual, SLA, Ball in court, Documents, Last update; tasks grouped under their milestone with progress', async () => {
    await signIn('reviewer');
    renderApp(<SiteAt />, { route: `/sites/${SITE}` });
    expect(await screen.findByTestId(`grid-open-${A1}`)).toBeInTheDocument();
    const heads = within(screen.getByTestId('task-grid-head')).getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads.slice(1, 11)).toEqual(['#', 'Code', 'Task', 'Status', 'Plan', 'Actual', 'SLA', 'Ball in court', 'Docs', 'Last update']);
    const stage = screen.getAllByTestId(/^grid-stage-/)[0]!;
    expect(stage).toHaveTextContent(/\d+\/\d+/);
    expect(within(screen.getByTestId(`grid-row-${A1}`)).getByTestId('row-no')).toHaveTextContent('1');
    // the shared toolbar is complete: views, search, + Filter, the count, the layouts, columns, density, Export
    const bar = screen.getByTestId('task-grid-toolbar');
    for (const a of ['data-has-search', 'data-has-filter', 'data-has-views', 'data-has-columns', 'data-has-density', 'data-has-export']) expect(bar).toHaveAttribute(a);
    expect(within(bar).getByTestId('site-view')).toBeInTheDocument();
    expect(screen.getByTestId('task-grid-count-text')).toHaveTextContent(/^\d+ tasks$/);
  });

  it('search narrows the tasks and the count says "x of y tasks"; a pasted list of task codes finds each', async () => {
    await signIn('reviewer');
    const u = userEvent.setup();
    renderApp(<SiteAt />, { route: `/sites/${SITE}` });
    await screen.findByTestId(`grid-open-${A1}`);
    const total = Number(screen.getByTestId('task-grid-count').getAttribute('data-total'));
    await u.type(screen.getByTestId('task-grid-search'), 'A1 a2');
    await waitFor(() => expect(screen.getByTestId('task-grid-count-text')).toHaveTextContent(`2 of ${total} tasks`));
    expect(screen.getAllByTestId('row-no').map((e) => e.textContent)).toEqual(['1', '2']);
    await u.click(screen.getByTestId('task-grid-count-clear'));
    await waitFor(() => expect(screen.getByTestId('task-grid-count-text')).toHaveTextContent(`${total} tasks`));
  });

  it('the + Filter tree of the task list goes to the server as `filter`', async () => {
    await signIn('reviewer');
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => { const x = new URL(request.url); if (x.pathname.endsWith('/tasks') && x.searchParams.get('filter')) seen.push(x.searchParams.get('filter')!); });
    const tree = encodeURIComponent(JSON.stringify({ op: 'and', items: [{ field: 'state', operator: 'is', value: 'open' }] }));
    renderApp(<SiteAt />, { route: `/sites/${SITE}?tadv=${tree}` });
    await screen.findByTestId(`grid-open-${A1}`);
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
  });

  it('the Timeline choice is remembered', async () => {
    localStorage.setItem('pmis.site.layout', '"timeline"');
    await signIn('reviewer');
    renderApp(<SiteAt />, { route: `/sites/${SITE}` });
    expect(await screen.findByTestId('task-row')).toBeInTheDocument();
    expect(screen.getByTestId('task-row-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('site-view')).toHaveAttribute('aria-label', expect.stringMatching(/Timeline|الخط/));
  });
});
