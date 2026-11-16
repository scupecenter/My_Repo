import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { components } from './schema';

/**
 * F5 (contract 0.15.32): the sites board by milestone and the tasks board by approval state (both read only), and the WIP limits of the
 * sites board (Settings, Workflow, Board).
 */
type S = components['schemas'];
export type SitesBoard = S['SitesBoard'];
export type SiteBoardCard = S['SiteBoardCard'];
export type TasksBoard = S['TasksBoard'];
export type TaskBoardColumn = TasksBoard['columns'][number]['key'];
export type KanbanWip = S['KanbanWip'];

type Query = Record<string, string | number | boolean | undefined | null | Array<string | number>>;
const clean = (q: Query): Query => Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== ''));

export const useSitesBoard = (q: Query, enabled = true) =>
  useQuery({ queryKey: ['boards', 'sites', clean(q)], enabled, placeholderData: keepPreviousData, queryFn: () => api.get<SitesBoard>('/boards/sites', { query: clean(q) }) });

export const useTasksBoard = (q: Query, enabled = true) =>
  useQuery({ queryKey: ['boards', 'tasks', clean(q)], enabled, placeholderData: keepPreviousData, queryFn: () => api.get<TasksBoard>('/boards/tasks', { query: clean(q) }) });

export const useKanbanWip = () => useQuery({ queryKey: ['kanban-wip'], queryFn: () => api.get<KanbanWip>('/settings/kanban-wip') });
export const useSetKanbanWip = () => {
  const qc = useQueryClient();
  return useMutation<KanbanWip, ApiError, { version: number; limits: Record<string, number | null>; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/kanban-wip', { version, body }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['kanban-wip'] }); void qc.invalidateQueries({ queryKey: ['boards'] }); },
  });
};
