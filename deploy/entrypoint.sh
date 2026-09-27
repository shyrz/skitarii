#!/bin/sh
# 容器入口：先把数据库 schema 推到最新，再启动 HTTP 进程。
#
# 迁移失败立即以非 0 退出（set -e）：宁可容器起不来，也不让新代码带着旧 schema 处理消息。
# 迁移与启动都依赖全量 node_modules（drizzle-kit、tsx），镜像构建期已装好，运行期不联网装包。
set -eu

cd /app
echo '[entrypoint] 应用数据库迁移'
pnpm db:migrate

# 后加的默认规则只会写进首次登记的群，既有群靠这一步在每次启动前补齐（幂等：只补缺失的 id，
# 不覆盖手改、不删除）。失败只告警不退出：默认规则缺失不影响服务可用，不该拖垮启动；
# 用与启动同一个 tsx 机制运行，避免依赖 pnpm 的脚本层。
echo '[entrypoint] 补齐缺失的默认规则（幂等，失败不阻塞启动）'
cd /app/apps/server
node --import tsx ../bot/src/backfill-default-rules.ts --apply || echo '[entrypoint] 默认规则补齐失败，已跳过（不阻塞启动）'

# 直接 exec node 让服务进程接管 PID 1：走 pnpm 会多一层子进程，SIGTERM 转发不可靠，
# 而 apps/server 依赖 SIGTERM 优雅退出（停调度器、关数据库连接、等在途请求收尾）。
# 不用 --env-file-if-exists：容器里没有 .env，环境变量由平台注入。
echo '[entrypoint] 迁移完成，启动 apps/server'
cd /app/apps/server
exec node --import tsx src/index.ts
