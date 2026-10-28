import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Nest needs decorator metadata, which esbuild does not emit: SWC compiles the TypeScript.
export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        keepClassNames: true,
      },
      module: { type: 'es6' },
    }),
  ],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 120000,
    // Each file builds its own app (own rate limiter); all share one throw-away database.
    fileParallelism: true,
  },
});
