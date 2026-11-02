/** Hybrid mode: mocks are on, and sign-in and users go to the real server (`VITE_REAL_API=auth-users`). No MSW import here. */
export const isHybrid = (useMocks: string | undefined, realApi: string | undefined) => useMocks === 'true' && realApi === 'auth-users';
export const HYBRID = isHybrid(import.meta.env.VITE_USE_MOCKS, import.meta.env.VITE_REAL_API);

/**
 * Jobs started on the real server (the bulk zip, contract 0.6.0). In hybrid mode `GET /jobs/:id` goes to the real server only for these ids; the
 * other jobs (the Master export, the security log export) are still mocked.
 */
const realJobs = new Set<string>();
export const trackRealJob = (id: string): void => { if (HYBRID) realJobs.add(id); };
export const isRealJob = (id: string): boolean => realJobs.has(id);
