/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  // Hybrid / real mode in `npm run dev`: set VITE_PROXY_TARGET (for example https://pmis.example.internal) to forward /api to that server.
  server: { port: 5173, proxy: process.env.VITE_PROXY_TARGET ? { '/api': { target: process.env.VITE_PROXY_TARGET, changeOrigin: true } } : undefined },
  test: {
    environment: 'jsdom',
    globals: true,
    env: { VITE_API_BASE_URL: 'http://localhost/api/v1' },
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
