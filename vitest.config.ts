import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@careflow/shared': r('./packages/shared/src/index.ts'),
      '@careflow/ring': r('./packages/ring/src/index.ts'),
      '@careflow/agent': r('./packages/agent/src/index.ts'),
      '@careflow/consent-engine': r('./packages/consent-engine/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
