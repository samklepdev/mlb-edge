import { defineConfig } from 'vitest/config';

// Scoped to src/. The package compiles to dist/ and vitest would otherwise
// collect the emitted copy of every test as well, running each one twice.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
