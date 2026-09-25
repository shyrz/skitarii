# skitarii

自用 Telegram 群组/频道消息审核工具。规则层先筛，低置信样本才送云端 LLM 复核，动作执行结果与申诉闭环都留痕。

当前进度：Phase 1 后端闭环已完成。审核管线、动作执行（幂等 + 限流退避）、Mini App 申诉 API、owner 处理流程、日聚合与保留期清理调度都在跑，调度器里还带两条兜底扫描：未执行决策的补偿执行与未送达 owner 通知的补发；Mini App 界面与频道/订阅能力归后续阶段。

## 结构

```
packages/core   领域层。类型权威、归一化、规则匹配、处置决策，纯函数，无 I/O 无框架依赖
packages/db     Postgres 存储层。drizzle schema、迁移、连接工厂、7 个仓储的 PG 实现与内存实现
packages/llm    云端 LLM 复核。OpenAI 兼容协议的调用实现、提示词、按判定指纹的缓存包装
apps/bot        审核运行时。createBot 工厂、消息管线、动作执行器、申诉回调（长轮询入口在 src/index.ts）
apps/server     node:http 进程。Telegram webhook、Mini App API、静态托管、维护调度器的宿主
apps/web        Mini App（Vite + React）
```

依赖方向单向：`apps/*` 与 `packages/db`、`packages/llm` 依赖 `packages/core`，core 不依赖任何包。领域类型只在 `packages/core/src/types.ts` 定义一次，其他层用 `import type` 取用。`apps/server` 依赖 `apps/bot`，因为 webhook 承载的正是同一个审核运行时。

## 架构与数据流

```
Telegram ──update──▶ apps/server /telegram/webhook ──▶ grammY webhookCallback
                                                          │
                                              apps/bot 的 update 处理器
                                                          │
   ┌──────────────────────────────────────────────────────▼───────────────────────────────────┐
   │ 消息管线 apps/bot/src/pipeline.ts                                                         │
   │ 1 落 MessageEvent（id 由 chatId+messageId 派生，重投递幂等；编辑消息带编辑时间+内容哈希   │
   │   判别符，每次编辑独立成事件）                                                            │
   │ 2 normalize → matchRules → scoreOf 分带                                                   │
   │     分数 < passThreshold        → 直接放行，不花钱                                        │
   │     score >= llmThreshold       → 直接按命中规则的 actionHint 处置                        │
   │     其余（灰色地带）             → 查 llm_cache，未命中才调云端复核                        │
   │ 3 decide 出最终动作（累犯加重看 7 天窗口内的历史违规数）                                   │
   │ 4 落 ModerationDecision；非放行时补写 message_events.sample_text 摘录（≤280 字符）        │
   │ 5 执行器施加动作（幂等键 = eventId + action，429 按 retry_after 退避）                     │
   └───────┬──────────────────────────────────────────────────────────────────────────────────┘
           │ 非放行
           ▼
   处置通知：私聊当事人优先（含申诉按钮），不可达回退群内；提交/结案时原通知被编辑为状态行
           │ 用户在 Mini App 提交
           ▼
   apps/server /api/appeals ──▶ Appeal(open) ──▶ bot 私聊 owner（维持 / 撤销 按钮）
                                                        │ owner 点击
                                                        ▼
                              撤销：unmute / unban + state=overturned，维持：state=upheld
                                                    （两者都写 resolvedAt / resolvedBy）

调度器（apps/server 进程内，默认每小时）：昨日与今日的日聚合重算 + 30 天保留期清理
                              + 未执行决策的补偿执行（复用 bot 的执行器与幂等闸门）
                              + 未通知 owner 的申诉补发（`appeals.notified_at is null`）
```

口径说明：

- 灰色地带拿不到复核结论（LLM 未配置、超时、限流、解析失败）时 `decide` 返回 `warn`，**且不计累犯**。理由见 `packages/core/src/decide.ts`：直接按 `actionHint` 动手等于悄悄把 `llmThreshold` 降到 `passThreshold`。
- 复核失败只记日志不上报错误：审核链路必须能只靠规则层运转。
- 复核结论在 `llm_cache` 里按判定指纹复用（30 天后清理）：指纹覆盖正文哈希、发送者身份、语言、消息特征、规则命中信号与误伤样例（顺序敏感），同一段正文换身份、换命中组合或换样例会重新复核，身份原文不落库。缓存只替代复核这一步，规则命中与 `decide` 每次都照常执行，因此群与群之间的配置差异不会被缓存抹平。

## 环境要求

- Node >= 22.12（开发与 CI 用 Node 26）
- pnpm 11
- Postgres 14 及以上（schema 只用常规特性）

## 启动

```bash
pnpm install
cp .env.example .env      # 填入 BOT_TOKEN / DATABASE_URL / OWNER_USER_ID 等
pnpm db:migrate           # 建表，需要 DATABASE_URL
pnpm build:web            # Mini App 产物落到 apps/web/dist，由 server 托管
pnpm dev:bot              # 长轮询 bot（本地开发用）
pnpm dev:server           # HTTP 服务，默认 3000；webhook 模式下由它驱动 bot
pnpm dev:web              # Mini App 开发服务器，5173
```

两个进程的启动脚本带 `--env-file-if-exists=../../.env`，因此 `pnpm dev:*`、`pnpm start` 会自动读取仓库根目录的 `.env`，文件不存在也不报错。已有环境变量优先于文件内容，生产部署按常规注入环境变量即可。Mini App 由 Vite 提供开发服务器，vite 自己读 `.env`。

生产部署建议只跑 `apps/server`：它挂 Telegram webhook、托管 Mini App 产物，并复用同一个 `createBot` 运行时。同时跑 `pnpm dev:bot`（长轮询）会与 webhook 抢更新，两者只选一只。

`pnpm db:migrate` 与 `pnpm db:generate` 不读 `.env` 文件，需要把 `DATABASE_URL` 放在环境里：

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/skitarii pnpm db:migrate
```

webhook 注册：设置了 `PUBLIC_URL` 时由服务启动阶段自动完成，无需手工操作（见「部署（容器 / Zeabur）」）；没设 `PUBLIC_URL` 时手工注册一次，可顺带用 `allowed_updates` 收窄更新类型：

```bash
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=https://your-host/telegram/webhook" \
  -d "secret_token=${WEBHOOK_SECRET}" \
  -d "allowed_updates=[\"message\",\"callback_query\"]"
```

## 部署（容器 / Zeabur）

镜像形态是单进程：`apps/server` 一个进程承担 Telegram webhook、Mini App API、`apps/web/dist` 静态托管与维护调度器。镜像里不做第二套 tsc 构建，server 用 `tsx` 直起 TS 源码，因此保留全量依赖（web 构建要 vite、迁移要 drizzle-kit、起服务要 tsx），理由写在 `Dockerfile` 注释里。

构建与启动顺序：

1. `pnpm install --frozen-lockfile`（含 devDependencies，见 `Dockerfile` 注释）
2. `pnpm build:web`，产出 `apps/web/dist`
3. 容器启动 `deploy/entrypoint.sh`：先 `pnpm db:migrate`，失败即以非 0 退出，不会带着旧 schema 起服务；成功后 `exec node --import tsx src/index.ts`
4. 进程监听 `PORT`（平台注入，缺省 3000）；`PUBLIC_URL` 非空时启动阶段调用 `setWebhook(${PUBLIC_URL}/telegram/webhook, { secret_token })`，幂等（每次启动重注册），失败只记日志、不阻断启动，Telegram 侧保留旧地址

迁移按单实例、低流量假设执行：每个实例启动都会跑一遍 `pnpm db:migrate`，多实例同时启动会并发执行迁移；0004 的 `CREATE INDEX` 会短暂持有表级 SHARE 锁（阻塞写入、允许读取），0006 的两次 `ADD COLUMN`（可空、无默认值）会短暂持有 ACCESS EXCLUSIVE 锁，自用规模下几乎无感。实例数或写入量上来后，应把迁移拆成独立的发布步骤，或改用手工执行的 `CREATE INDEX CONCURRENTLY`。

```bash
docker build -t skitarii .
docker run --rm --env-file .env -p 3000:3000 skitarii
```

镜像构建与真实迁移尚未在本机实测（开发机没有 Docker），待 Zeabur 实测后回填记录。

### 环境变量

对照 `.env.example` 逐项说明。必填项缺失或取值非法时，进程在启动阶段退出并列出问题变量。

| 变量 | 必填 | 用途 |
| --- | --- | --- |
| `BOT_TOKEN` | 是 | BotFather 生成的 bot token；webhook 校验与所有出站调用共用。 |
| `WEBHOOK_SECRET` | 是 | 提交给 `setWebhook` 的 `secret_token`，也用于校验入站请求头 `X-Telegram-Bot-Api-Secret-Token`。建议 `openssl rand -hex 32` 生成；换地址不改值。 |
| `DATABASE_URL` | 是 | Postgres 连接串（postgres.js 格式）；迁移与服务都读它。 |
| `MINI_APP_URL` | 是 | 申诉按钮的目标地址，形如 `${MINI_APP_URL}?startapp=${decisionId}`。 |
| `OWNER_USER_ID` | 是 | 申诉负责人（Telegram 数字 id）：新申诉私聊该用户，也只有该用户能维持/撤销。 |
| `OWNER_DEBUG_NOTIFY` | 否 | owner 判定 feed 开关：每条过审消息（含放行）私聊 owner 一条判定摘要。缺省开启；只接受 `true`/`false`，置 `false` 关闭。 |
| `PUBLIC_URL` | 否 | 服务对外根地址；非空时启动阶段自动注册 webhook，空串或缺省跳过。 |
| `PORT` | 否 | HTTP 监听端口，缺省 3000；Zeabur 等平台会注入自己的值。 |
| `LLM_BASE_URL` | 否 | 云端 LLM 的 OpenAI 兼容服务根地址，不含 `/chat/completions`。 |
| `LLM_API_KEY` | 否 | 对应 API key。 |
| `LLM_MODEL` | 否 | 模型名，例如 `gpt-4o-mini`。 |
| `LLM_TIMEOUT_MS` | 否 | 复核请求超时（毫秒），缺省 30000。三个 `LLM_*` 缺任意一项即视为「未配置复核」，灰色地带按待复核处理。 |
| `MAINTENANCE_INTERVAL_MS` | 否 | 维护任务（日聚合重算 + 保留期清理）间隔（毫秒），缺省 3600000。 |

自动注册只提交 `secret_token`，不限制 `allowed_updates`：没有处理器的更新类型到达后不会产生动作，只是多几跳流量；要收窄就按上面手工注册的 curl 覆盖一次。

### BotFather 前置步骤

按顺序完成，BotFather 的命令名与界面提示以实际回复为准（待实测回填）：

- [ ] 在 @BotFather 新建 bot，记下 `BOT_TOKEN`
- [ ] `/setprivacy` 选中该 bot，设为 `Disable`（否则读不到全群消息，审核管线收不到非命令消息）
- [ ] 把 bot 拉进目标群，并授予管理员权限（删除消息 / 禁言 / 封禁都需要）
- [ ] 注册 Mini App URL：Mini App 由本服务托管在 `${PUBLIC_URL}/app/`，按 BotFather 的 Mini App 流程把地址指过去
- [ ] 生成 `WEBHOOK_SECRET`：`openssl rand -hex 32`

### Zeabur

本仓库对 Zeabur 的形态是根 `Dockerfile` 直建。根目录存在 Dockerfile 时优先于 zbpack 自动检测，不需要 `zbpack.json` 之类的配置文件。

首次接入（一次性）：

1. Dashboard 的 Settings → Integrations 绑定 GitHub，安装 Zeabur GitHub App 并授权本仓库。
2. 项目内 Add Service → GitHub，选中本仓库。构建根目录保持仓库根，根 Dockerfile 生效。
3. Databases 添加 PostgreSQL（官方模板）。
4. 应用服务 Variables 补齐环境变量，关键值可直接引用平台变量免手填：
   - `DATABASE_URL` 填 `${POSTGRES_CONNECTION_STRING}`
   - `PUBLIC_URL` 填 `${ZEABUR_WEB_URL}`（用自定义域名就填该域名地址）
   - `MINI_APP_URL` 填 `https://t.me/<bot>/<app>` 形式的 Mini App 直链，`<bot>` 是 bot 用户名，`<app>` 是 BotFather 里注册的 Mini App 短名
   - `BOT_TOKEN`、`WEBHOOK_SECRET`、`OWNER_USER_ID` 按「环境变量」表填写
   Variables 支持 Edit as Raw 按 `.env` 形态批量粘贴。
5. Settings → Health Check 的 HTTP path 设为 `/healthz`。健康检查通过后才切流量，失败保留旧版本。
6. 域名用 Generate Domain 免费拿 `*.zeabur.app`，或 Custom Domain 配 CNAME，TLS 证书自动签发。

此后 push 到跟踪分支即触发自动构建部署，构建在 Zeabur CI 打镜像，启动链路见上一节。只想让部分目录变更触发部署时配 Watch Paths，语法同 `.gitignore`。

Zeabur 的 README「Deploy to Zeabur」按钮走模板机制，模板内服务要求是已发布镜像（PREBUILT_V2），纯 Git 仓库不适用。本项目的「一键」语义就是 GitHub 集成下的 push 即部署。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm typecheck` | 所有工作区的 `tsc --noEmit`（strict，含 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`） |
| `pnpm test` | vitest 全量测试；单包用 `pnpm vitest run packages/core` |
| `pnpm build:web` | 构建 Mini App，产物在 `apps/web/dist` |
| `pnpm db:generate` | 按 schema 生成迁移到 `packages/db/drizzle` |
| `pnpm db:migrate` | 应用迁移 |

## HTTP 接口

Mini App 的申诉与面板接口是冻结契约，界面按这里实现。所有时间字段都是 ISO 8601 字符串（`JSON.stringify` 的 Date 形态）。

### `GET /healthz`

只表示进程活着，不探数据库。`200 {"status":"ok"}`。

### `POST /telegram/webhook`

Telegram 更新入口。请求头 `X-Telegram-Bot-Api-Secret-Token` 必须等于 `WEBHOOK_SECRET`，校验由 grammY 的 `webhookCallback` 完成（常数时间比较），不匹配返回 401，`allowed_updates` 只需 `message` 与 `callback_query`。

### `GET /api/appeals/:decisionId?initData=...`

读取一条处置与它的申诉。**initData 走查询串**（GET 没有 body，也不引入自定义请求头）。

- `200`：处置当事人本人或 owner 可见
- `401 {"error":"init_data_invalid"}`：initData 缺失、签名不通过或超过 1 小时
- `404 {"error":"decision_not_found"}`：处置不存在、路径参数不是 uuid，或请求者无权查看（无权与不存在用同一个响应，避免探测他人处置）

```json
{
  "decision": {
    "id": "9c8b7a65-1111-4222-8333-999900001111",
    "action": "mute",
    "actionUntil": "2026-09-23T11:00:00.000Z",
    "chatTitle": "测试群",
    "createdAt": "2026-09-23T10:00:01.000Z",
    "sampleText": "加微信推荐一个渠道"
  },
  "appeal": {
    "id": "a1b2c3d4-1111-4222-8333-555566667777",
    "state": "open",
    "reason": "这是我自己的闲置转让",
    "createdAt": "2026-09-23T10:05:00.000Z",
    "resolvedAt": null
  }
}
```

`action` 是档位字符串，取 `warn | delete | mute | ban`（申诉页只会看到非放行处置）。`mute` 的截止时刻在 `actionUntil`，其余档位为 `null`。`appeal` 为 `null` 表示还没有人提交申诉；`state` 取 `open | upheld | overturned`。`sampleText` 是处置时的正文摘录（≤280 字符），纯媒体消息（没有文本）为 `null`。

### `POST /api/appeals`

```json
{ "initData": "<Telegram.WebApp.initData>", "decisionId": "9c8b7a65-1111-4222-8333-999900001111", "reason": "误判了" }
```

- `201 {"appeal":{...}}`：创建成功，`appeal` 与上文字段一致
- `400 {"error":"invalid_request","details":[...]}`：`reason` 少于 1 字或多于 500 字、字段缺失
- `401 {"error":"init_data_invalid"}`
- `404 {"error":"decision_not_found"}`：处置不存在或不属于请求者
- `409 {"error":"appeal_exists"}`：该处置已经提交过申诉（一条处置只受理一次，重复提交不覆盖理由）

提交成功后 bot 会私聊 owner 一条通知，附「维持原处置 / 撤销并解除限制」两个按钮；同时把原处置通知编辑为「等待复核」并去掉按钮（私聊通知用「已收到你的申诉，等待复核」）。撤销会回滚权限（mute 解禁、ban 解封），并把申诉置为 `overturned`，写 `resolvedAt` 与 `resolvedBy`；维持置为 `upheld`。结案后原通知编辑为终态文案（撤销 / 维持，私聊用第二人称），并给当事人发一条结案私聊；即使权限回滚失败也照发（记录层已经撤销，权限由补偿扫描与 owner 兜底），通知文案不承诺恢复已删除的消息内容。已结案的申诉不会被重复点击翻转。

处置通知的投递是两态的：先私聊被处置人（附申诉入口按钮）；对方从未与 bot 私聊或被拉黑（Telegram 403）时回退群内通知（匿名文案 + 申诉按钮）。实际落点记在决策上，供上面的生命周期编辑使用；编辑是 best-effort，引用缺失或编辑失败（消息过旧等）只记日志，不影响提交与结案。

**误伤样本回写。** 撤销结案的申诉会回写判定链路（Phase 2c）：灰色地带送审时，该群最近 90 天内被撤销过的消息摘录（非空、最多 5 条、最近优先）作为复核提示词的参照样例，降低同类误判复发；同一用户在 30 天内被撤销过的**同内容**消息再次出现时直接放行（不调复核、不执行动作，仅落事件与决策留痕）。样本读取只在「本会被处置」（规则分达到放行阈值）的消息上发生，失败按无样本降级。复核缓存指纹随之升到 v2。

通知没被 Telegram 接受时（owner 从未与 bot 私聊过、网络抖动）不会让提交失败：这条申诉留在 `notified_at` 为空的状态，调度器的补发扫描会重试。代价是极端情况下可能收到重复的同一条提醒，而不会出现「申诉静默地没人处理」。

### 面板接口（owner 专属）

跨群管理台（Mini App 面板视图）的数据面。所有 `/api/panel/*` 端点先验 initData，再要求 `userId === OWNER_USER_ID`；GET 的凭据在查询串，POST 与 PUT 的在 body。列表端点都在 SQL 侧完成过滤、排序与 limit，群标题与正文摘录批量取，不做 N+1 查询。

鉴权失败的状态码对所有端点一致：

- `401 {"error":"init_data_invalid"}`：缺凭据、验签失败或过期（前端提示重新从 Telegram 打开）
- `403 {"error":"forbidden"}`：验签通过但不是 owner（前端提示仅管理员可用）

#### `GET /api/panel/overview?initData=...`

```json
{
  "totals": {
    "today": { "messageCount": 12, "actionCount": 3, "appealCount": 1, "overturnedCount": 0 },
    "last7d": { "messageCount": 80, "actionCount": 11, "appealCount": 4, "overturnedCount": 1 }
  },
  "chats": [
    {
      "chatId": "-1001234567890",
      "title": "测试群",
      "today": { "messageCount": 12, "actionCount": 3, "appealCount": 1, "overturnedCount": 0 },
      "last7d": { "messageCount": 80, "actionCount": 11, "appealCount": 4, "overturnedCount": 1 },
      "openAppeals": 2
    }
  ],
  "serverTime": "2026-09-23T12:00:00.000Z"
}
```

`chats` 按近 7 日 `actionCount` 降序，同分按 `chatId` 升序；`today` 与 `last7d` 按 UTC 切日，近 7 日含今天。`openAppeals` 是各群待处理申诉数。

#### `GET /api/panel/chats/:chatId/series?days=30&initData=...`

```json
{ "chatId": "-1001234567890", "days": [ { "date": "2026-08-25", "messageCount": 0, "actionCount": 0, "appealCount": 0, "overturnedCount": 0 } ] }
```

序列升序且日期连续，缺失日补零。`days` 默认 30，clamp 到 [7, 90]。调度器每小时滚动日报，今天的数字可能滞后至多一小时。

#### `GET /api/panel/chats/:chatId/config?initData=...`

```json
{
  "chatId": "-1001234567890",
  "title": "测试群",
  "language": "zh",
  "passThreshold": 0.3,
  "llmThreshold": 0.8,
  "muteDurationMinutes": 60,
  "rules": [
    { "id": "default-ad-wechat", "kind": "keyword", "pattern": "加微信", "score": 0.4, "actionHint": "delete", "enabled": true }
  ]
}
```

响应就是 `ChatConfig` 本体。`language` 目前只读（切换不在本批范围）。未知群 `404 {"error":"chat_not_found"}`。

#### `PUT /api/panel/chats/:chatId/config`

```json
{
  "initData": "<Telegram.WebApp.initData>",
  "config": {
    "passThreshold": 0.3,
    "llmThreshold": 0.8,
    "muteDurationMinutes": 60,
    "rules": [{ "id": "default-ad-wechat", "kind": "keyword", "pattern": "加微信", "score": 0.4, "actionHint": "delete", "enabled": true }]
  }
}
```

全量替换规则与阈值，保留 `title` / `language`；保存后管线立即读到新配置。`rules` 里的 `id` 可省略或为空串，服务端分配 `custom-<8位十六进制>` 并随响应返回。

响应包装：GET 直接返回配置本体，PUT 把同一形状包在 `config` 键下，前端解析时不要混用。判定顺序是结构 → 鉴权 → 群存在 → 语义校验：未知群即使配置非法也先返回 `404 chat_not_found`。`details` 最多 50 条，超出时截断并以 `…等 N 条其他错误` 汇总。

- `200 {"config":{...}}`：与 GET 同形（注意外层包了 `config` 键），含服务端分配后的 id
- `400 {"error":"invalid_request","details":[...]}`：逐条指出第几条规则的哪个字段。校验口径：`0 ≤ passThreshold ≤ llmThreshold ≤ 1`；`muteDurationMinutes` 为 1..43200 的整数；规则至多 100 条、id 不得重复；`kind` 取 `keyword | regex | link-domain | sender-name | custom-emoji | emoji-count | via-bot`；`pattern` 非空（纯空白同样拒绝），`regex` / `sender-name` 需能按 `u` 标志编译，`custom-emoji` / `emoji-count` 需为十进制计数，`via-bot` 不使用 pattern（允许空串）；`score ∈ [0,1]`；`actionHint` 取五个档位；`enabled` 为布尔
- `401 {"error":"init_data_invalid"}` / `403 {"error":"forbidden"}`
- `404 {"error":"chat_not_found"}`：群未登记（保存不会隐式创建群配置）

#### `GET /api/panel/decisions?initData=&chatId=&action=&limit=50&before=ISO&beforeId=uuid`

```json
{
  "items": [
    {
      "id": "9c8b7a65-1111-4222-8333-999900001111",
      "chatId": "-1001234567890",
      "chatTitle": "测试群",
      "userId": 7000000001,
      "action": "delete",
      "actionUntil": null,
      "score": 0.9,
      "executed": true,
      "decidedAt": "2026-09-23T10:00:01.000Z",
      "ruleIds": ["default-ad-wechat"],
      "llm": { "verdict": "spam", "confidence": 0.92 },
      "sampleText": "加微信推荐一个渠道"
    }
  ],
  "nextBefore": { "decidedAt": "2026-09-23T10:00:01.000Z", "id": "9c8b7a65-1111-4222-8333-999900001111" }
}
```

默认只返回非放行（`action != 'pass'`）；`action=all` 或具体档位（`pass | warn | delete | mute | ban`）可覆盖，非法取值 400。排序 `(decidedAt, id)` 倒序，`limit` 默认 50、上限 100。

游标是复合的：`nextBefore` 非 `null` 时把 `decidedAt` 与 `id` 分别作为 `before` 与 `beforeId` 原样传回。两个参数必须成对出现且格式合法（`before` 为 ISO、`beforeId` 为 uuid），缺一或非法一律 400：同一毫秒可能有多条记录，只按时间翻页会静默漏条，因此后端不接受半截游标。`sampleText` 为 `null` 表示没有摘录（放行、纯媒体或已被保留期清理）。

#### `GET /api/panel/appeals?initData=&state=open|upheld|overturned|all&limit=50`

```json
{
  "items": [
    {
      "id": "a1b2c3d4-1111-4222-8333-555566667777",
      "userId": 7000000001,
      "state": "open",
      "note": "这是我自己的闲置转让",
      "createdAt": "2026-09-23T10:05:00.000Z",
      "resolvedAt": null,
      "decision": {
        "id": "9c8b7a65-1111-4222-8333-999900001111",
        "action": "mute",
        "actionUntil": "2026-09-23T11:00:00.000Z",
        "score": 0.8,
        "chatId": "-1001234567890",
        "chatTitle": "测试群",
        "sampleText": "加微信推荐一个渠道"
      }
    }
  ]
}
```

默认 `state=open`，`all` 表示全部状态，非法取值 400。按申诉创建时间倒序，`limit` 默认 50、上限 100。

#### `POST /api/panel/appeals/:appealId/resolve`

```json
{ "initData": "<Telegram.WebApp.initData>", "resolution": "upheld" }
```

- `200 {"state":"upheld"|"overturned","rollbackFailed":false}`：结案成功。`rollbackFailed=true` 表示撤销已生效但权限回滚失败（Telegram 拒绝），前端提示「已结案，但解除限制失败：请手动解禁或解封」
- `400 {"error":"invalid_request","details":[...]}`：请求体不合法（鉴权前先校验）
- `401 {"error":"init_data_invalid"}` / `403 {"error":"forbidden"}`
- `404 {"error":"appeal_not_found"}`：申诉或关联决策不存在，路径参数不是 uuid 也按此处理
- `409 {"error":"appeal_resolved"}`：申诉已被处理（含并发点击）

`404` 有两类，前端都按「记录不存在」处理：路径形状不对（如 `/api/panel/appeals/foo`，缺少 `/resolve` 尾段）由路由层返回 `{"error":"not found"}`，不会进到业务逻辑；形状正确但资源不存在（含非 uuid 的申诉 id）返回上面的 `appeal_not_found`。

结案与 Telegram 回调按钮共用同一实现（`resolveAppeal`），撤销会回滚权限（mute 解禁、ban 解封；管理员/群主不可罚目标跳过），并把申诉置为 `overturned` 或 `upheld`。结案与回滚是两步：撤销时先写入 `appeals.rollback_pending` 标记再回滚，中途崩溃留下的标记由调度器的补偿扫描补跑（解禁/解封幂等）。

### `GET /app/*`

Mini App 静态产物，对应 `apps/web/dist`。找不到文件且路径没有扩展名时回退到 `index.html`，路径解析后必须在产物目录内（`..` 与百分号编码逃逸一律 404）。跑 `pnpm build:web` 之前访问会得到 404。

### initData 校验口径

`secret = HMAC_SHA256(key="WebAppData", message=bot_token)`，`hash = HMAC_SHA256(key=secret, message=data_check_string)`，`data_check_string` 是**除 `hash` 外全部收到字段**（含 `signature`）按 `key=value` 排序后用换行连接。「排除 hash 与 signature」是第三方 Ed25519 校验（另一串字符串）的规则，混用会让所有带 signature 的真实 initData（Bot API 8.0 起客户端一律携带）验签失败。`auth_date` 与当前时间相差超过 1 小时即拒绝（允许 60 秒的时钟快偏移）；Mini App 每次打开都会拿到新的 initData，正常使用中用户无感。

## 关键约定

**正文默认不留存，处置对象留摘录。** `message_events` 只有 `content_hash` 与特征列（是否有链接、媒体类型、长度、自定义表情数、表情总数、是否经内联机器人发送）；唯一的正文落地形态是 `sample_text`，一条被判非放行的消息的原文摘录（≤280 字符），用于申诉复核与事后复盘。它由 SQL 条件强制：只有同事件存在非 `pass` 决策时才允许写入，放行消息的正文没有任何写入路径。

**归一化是所有匹配的前提。** 文本先过 `normalize`，规则 pattern 按归一化后的形态编写（小写、简体、无拆词标点）。`normalize` 会把「加v」改写成「加微信」，按原始写法写规则永远匹配不上，新增规则前先跑一遍归一化。发送者身份（显示名与 `@用户名`）走同一套归一化，`kind: 'sender-name'` 的规则匹配的是身份而非正文；身份只存在于运行时，不落库。绕过词表在 `packages/core/src/normalize-map.ts`，扩充只改数据。

**双阈值决定要不要花钱。** `passThreshold` 以下直接放行；`llmThreshold` 以上直接按命中的规则处置；只有落在中间的样本才调用 LLM。灰色地带没拿到复核结论时返回 `warn`，不执行破坏性动作。

**规则与阈值可在面板里编辑。** 规则集、双阈值与禁言时长在 Mini App 面板的「规则」页签编辑，保存后立即生效（管线每条消息读配置）。保存边界会挡住坏数据（阈值乱序、坏正则、非法枚举、超量规则等）并逐条指出第几条规则的哪个字段，与 README 既有口径「规则编译失败在保存接口暴露」一致。

**默认配置只在群首次登记时写入。** 新群拿到 15 条默认规则（含 `default-emoji-flood`：表情总数 ≥6；`default-inline-bot`：经内联机器人发送，pattern 不使用），此后配置以数据库为准；已登记的群不会自动追加新默认规则，需要时在面板手动添加。表情总数把普通 Unicode 表情也计入（`custom-emoji` 只覆盖付费自定义表情），按用户感知每个表情恰计一次（ZWJ 序列如家庭表情计 1，不再按码位拆开）；两者叠加后有意的语义收紧：≥6 个自定义表情会同时命中 `default-emoji-burst` 与 `default-emoji-flood`（0.8 直接处置）。

**重复投递不重复处置。** 事件 id 由 `(chatId, messageId)` 派生（编辑消息附加 `edit:${edit_date}:${内容哈希前 16 位}` 判别符：同一秒内不同内容的编辑各自成事件，编辑回退到早前内容时复用当时的事件 id、不再重审），决策 id 由事件 id 派生，落库用 `on conflict do nothing`；执行侧再叠一层 `eventId + action` 的进程内幂等闸门与 `moderation_decisions.executed` 回填。Telegram 重投递同一 update 的效果是「什么都不再发生」。

**不变量尽量进 DDL。** 阈值必须有序、`mute` 才带解禁时刻、置信度与分数限定在 0..1、结案状态与结案时间/结案人必须一致、一条处置至多一条申诉，这些都写成 CHECK 与唯一索引，绕过应用的写入同样会被拒绝。

**出站消息限流。** 每个目标一个令牌桶（容量 3、20 条/分钟）：群内通知以群 id 为键，私聊通知以用户 id 为键，各自独立；警示语与处置通知是可丢消息，桶空时跳过发送（私聊被限流时仍会尝试群内兜底）。动作本身不受限流影响，它只受 Telegram 的 429 约束，按 `retry_after` 退避重试。

**依赖冻结。** 依赖在脚手架阶段一次性装齐，后续 lane 不新增外部依赖。需要新库时先改根 `package.json` 与各包 `package.json`，再重跑 `pnpm install`。

## Phase 1 的已知边界

- 误伤样本回写：复核缓存的判定指纹在 Phase 2c 升到 v2（把样例纳入键），旧指纹的缓存不再命中，等 30 天保留期清理自然消失；内容白名单的自动放行窗口固定 30 天、样本回看窗口 90 天，都不随群配置调整。
- 频道消息（`channel_post`）与 linked discussion 评论、订阅门禁（`subscriptions` 表已就位）按计划留到 Phase 3。
- 日聚合按 UTC 切日：`ChatConfig` 里没有时区字段，跨时区部署的看板边界会有一天偏差，比值类指标不受影响。
- 规则集、阈值与禁言时长可以在面板里编辑，也可以直接改数据库或走 `ChatRepo.upsert`：两处没有版本协调（单 owner 最后写入胜），并发编辑面板与数据库不会互相提示。
- 单进程假设：幂等闸门与令牌桶都在进程内，多实例部署前需要把它们挪到共享存储。
- 累犯计数在并发处理下的阈值竞态：`countPriorViolations` 读的是已落库的决策数，同一用户两条消息被并发处理时，两边都可能数到「还差一条」而不加重档位（漏加重）。窗口内累计三次的判定因此是尽力而为，不保证严格；要严格需要给 `(chatId, userId)` 加锁或改成数据库侧的原子计数。
- 时间源没有贯穿 `decide`：`mute` 的解禁时刻由 `packages/core` 的 `decide` 直接读 `Date.now()` 算出，不经过管线注入的 `now`。正常运行时两者是同一个挂钟，影响只在测试与本地跑批：要用自定义时间源断言 `mute.until` 时得先冻结 `Date`。
- 同一消息的每次编辑产生独立事件与决策，频繁编辑会加速累犯计数（设计取舍：每次编辑是独立违规事件，不合并计数）。判别符是 `edit:${edit_date}:${内容哈希前 16 位}`：同一秒内不同内容的编辑各自成事件；编辑回退到早前内容时复用当时的事件 id，跳过重审（该状态已审过，代价是回退后不会按新语境重新判定）。
- 补偿重投递窗口内处置通知可能重复（Telegram 重投递、崩溃恢复重跑执行器时各发一条），通知引用只记最后一条，申诉生命周期的编辑作用于它，更早的那条留在原地。
