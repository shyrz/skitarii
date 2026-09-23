#!/bin/sh
# 容器入口：先把数据库 schema 推到最新，再启动 HTTP 进程。
#
# 迁移失败立即以非 0 退出（set -e）：宁可容器起不来，也不让新代码带着旧 schema 处理消息。
# 迁移与启动都依赖全量 node_modules（drizzle-kit、tsx），镜像构建期已装好，运行期不联网装包。
set -eu

cd /app
echo '[entrypoint] 应用数据库迁移'
pnpm db:migrate

# 直接 exec node 让服务进程接管 PID 1：走 pnpm 会多一层子进程，SIGTERM 转发不可靠，
# 而 apps/server 依赖 SIGTERM 优雅退出（停调度器、关数据库连接、等在途请求收尾）。
# 不用 --env-file-if-exists：容器里没有 .env，环境变量由平台注入。
echo '[entrypoint] 迁移完成，启动 apps/server'
cd /app/apps/server
exec node --import tsx src/index.ts
