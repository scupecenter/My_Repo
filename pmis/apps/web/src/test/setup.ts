import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanup } from '@testing-library/react';
import { server } from '@/mocks/server';
import { resetDb } from '@/mocks/db';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); server.resetHandlers(); resetDb(); localStorage.clear(); });
afterAll(() => server.close());
