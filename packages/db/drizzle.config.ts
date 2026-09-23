import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit 配置。
 *
 * `generate` 只读 `src/schema.ts`，不需要数据库；`migrate` 需要环境里的 `DATABASE_URL`。
 * 迁移产物落在 `./drizzle`，进版本库；改 schema 后先 `pnpm db:generate` 再 `pnpm db:migrate`。
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
})
