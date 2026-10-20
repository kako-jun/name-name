import { defineConfig } from 'vitest/config'

// #877 段階 3: 戦闘の検証ハーネス（手動実行）。通常の `vitest`（vitest.config.ts）には入らない。
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/game/battleHarness/**/*.sweep.mjs'],
  },
})
