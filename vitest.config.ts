import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['apps/game/test/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'packages/domain/*/test/**/*.test.ts'], testTimeout: 60_000 } });
