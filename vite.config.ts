import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // Relative paths, so the build works on GitHub Pages under any repository name.
  base: './',
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    testTimeout: 120_000,
  },
});
