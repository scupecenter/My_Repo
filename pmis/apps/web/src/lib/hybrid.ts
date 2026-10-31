/** Hybrid mode: mocks are on, and sign-in and users go to the real server (`VITE_REAL_API=auth-users`). No MSW import here. */
export const isHybrid = (useMocks: string | undefined, realApi: string | undefined) => useMocks === 'true' && realApi === 'auth-users';
export const HYBRID = isHybrid(import.meta.env.VITE_USE_MOCKS, import.meta.env.VITE_REAL_API);
