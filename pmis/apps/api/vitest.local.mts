import { defineConfig } from 'vitest/config';

// Local box has no Postgres server: run only the pure rules tests, CI covers the DB suites.
export default defineConfig({
  test: {
    include: ['test/dashboard-ops.rules.test.ts'],
  },
});
