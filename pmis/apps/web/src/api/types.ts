import type { components } from './schema';

type S = components['schemas'];
export type Problem = S['Problem'];
export type Session = S['Session'];
export type Me = S['Me'];
export type UserRef = S['UserRef'];
export type TaskSummary = S['TaskSummary'];
export type TaskDetail = S['TaskDetail'];
export type ApprovalItem = S['ApprovalItem'];
export type BulkResult = S['BulkResult'];
export type StaffCard = S['StaffCard'];
export type Notification = S['Notification'];
export type TransitionResult = S['TransitionResult'];
export type Page<T> = { items: T[]; page: S['PageInfo'] };
