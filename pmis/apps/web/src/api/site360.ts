import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { components } from '@/api/schema';

/** SITE 360 menus and the Master columns of each (contract 0.15.21, F15). */
export type Site360Sections = components['schemas']['Site360Sections'];
export type Site360MenuItem = components['schemas']['Site360MenuItem'];
export type Site360Menu = components['schemas']['Site360Menu'];
export type Site360Band = components['schemas']['Site360Band'];

/** The eight SITE 360 menus in menu order: Master first, then the sections. */
export const SITE360_MENU_KEYS: Site360Menu[] = ['master', 'design_acq', 'sow', 'cw', 'te', 'hoto', 'dismantle', 'om'];

export const useSite360Sections = () =>
  useQuery({ queryKey: ['site360-sections'], queryFn: () => api.get<Site360Sections>('/site360/sections') });
