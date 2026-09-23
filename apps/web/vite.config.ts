import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Mini App 构建配置。
 *
 * `base: './'` 用相对路径：产物由 apps/server 托管在某个路径前缀下（当前约定 `/app/`），
 * 相对基址让挂载点可调而不必重新构建。
 * 开发端口固定 5173，便于 server 侧配置跨域与回调；生产产物落在 `dist/`。
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { port: 5173 },
})
