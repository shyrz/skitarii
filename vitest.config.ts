import { defineConfig } from 'vitest/config'

/**
 * 仓库级测试配置：单一 root 配置覆盖所有包的 `*.test.ts`，避免后续 lane 反复修改同一份配置。
 * 按路径过滤即可只跑一个包，例如 `pnpm vitest run packages/core`。
 */
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
  },
})
