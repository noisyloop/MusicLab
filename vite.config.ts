/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative base so the build works from any static host path (including subfolders).
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
