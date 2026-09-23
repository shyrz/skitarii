# 部署镜像：单进程。Telegram webhook、Mini App API、apps/web/dist 静态托管与维护调度器都在 apps/server 里。
#
# server 不做第二套 tsc 构建，用 tsx 直起 TS 源码，与 `pnpm dev:server` / `pnpm test` 跑同一份代码：
# 所有工作区包的 exports 直指 src/*.ts，要出编译产物就得跨包重映射路径或再拷一份源码，
# 收益只有镜像小一点，代价是多一条会与开发环境漂移的构建链路。可靠启动优先于镜像精巧。
FROM node:24-slim

# pnpm 本体缓存在共享目录：构建期的 `pnpm install` 会把 packageManager 字段指定的版本下载到这里，
# 运行时的非 root 用户直接读缓存，不依赖容器启动时的网络。
ENV COREPACK_HOME=/usr/local/share/corepack
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# 镜像自带的 corepack 可能旧于 npm 的签名密钥轮换（装 pnpm 时报 Cannot find matching keyid），
# 先升级再启用；pnpm 版本仍由根 package.json 的 packageManager 字段钉住。
RUN npm install -g corepack@latest && corepack enable \
    && mkdir -p "$COREPACK_HOME" && chown node:node "$COREPACK_HOME"

WORKDIR /app

# 全量拷贝。Zeabur 每次都是全新构建，先拷清单再装依赖拿不到跨构建缓存，
# 却会在新增工作区包时漏拷 package.json；.dockerignore 已排除宿主机的 node_modules、产物与 .env。
# --chown=node:node：安装与运行都在非 root 用户下进行。
COPY --chown=node:node . .

RUN chmod +x deploy/entrypoint.sh

USER node

# 刻意装全量依赖（含 devDependencies）：web 构建要 vite、迁移要 drizzle-kit、起服务要 tsx
# （tsx 目前是 apps/server 的 devDependency；将来若把镜像裁成 --prod，必须先把 tsx 挪进 dependencies）。
# env -u NODE_ENV 防御构建环境注入 NODE_ENV=production：pnpm 见到它会跳过 devDependencies，整条链路就装不全。
RUN env -u NODE_ENV pnpm install --frozen-lockfile
RUN pnpm build:web

# PORT 由运行环境注入（Zeabur 会注入），应用缺省 3000。
EXPOSE 3000

ENTRYPOINT ["/app/deploy/entrypoint.sh"]
