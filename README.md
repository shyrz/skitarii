# skitarii

自用 Telegram 群组/频道消息审核工具。规则层先筛，低置信样本才送云端 LLM 复核，动作执行结果与申诉闭环都留痕。

当前进度：Phase 1 后端闭环、Phase 2 面板与 Phase 3a（频道登记 + linked discussion 评论关系）已完成；Phase 3b 后端（订阅链接台账 + 成员观测台账 + 60 秒对账 + owner 订阅端点）已就位，对应的 Mini App 订阅页签由 web lane 提供、对接见「HTTP 接口」。审核管线、动作执行（幂等 + 限流退避）、Mini App 申诉与面板 API、日聚合与保留期清理调度都在跑，调度器里带三条兜底扫描：未执行决策的补偿执行、未送达 owner 通知的补发与撤销结案后的权限回滚补偿。

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

webhook 注册：设置了 `PUBLIC_URL` 时由服务启动阶段自动完成，无需手工操作（见「部署（容器 / Zeabur）」）；没设 `PUBLIC_URL` 时手工注册一次。注册时会带上与长轮询共用同一份名单的 `allowed_updates`（`message`、`edited_message`、`callback_query`、`channel_post`、`my_chat_member`、`chat_member`），手工注册照抄这份名单即可：

```bash
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=https://your-host/telegram/webhook" \
  -d "secret_token=${WEBHOOK_SECRET}" \
  -d "allowed_updates=[\"message\",\"edited_message\",\"callback_query\",\"channel_post\",\"my_chat_member\",\"chat_member\"]"
```

## 部署（容器 / Zeabur）

镜像形态是单进程：`apps/server` 一个进程承担 Telegram webhook、Mini App API、`apps/web/dist` 静态托管与维护调度器。镜像里不做第二套 tsc 构建，server 用 `tsx` 直起 TS 源码，因此保留全量依赖（web 构建要 vite、迁移要 drizzle-kit、起服务要 tsx），理由写在 `Dockerfile` 注释里。

构建与启动顺序：

1. `pnpm install --frozen-lockfile`（含 devDependencies，见 `Dockerfile` 注释）
2. `pnpm build:web`，产出 `apps/web/dist`
3. 容器启动 `deploy/entrypoint.sh`：先 `pnpm db:migrate`，失败即以非 0 退出，不会带着旧 schema 起服务；成功后 `exec node --import tsx src/index.ts`
4. 进程监听 `PORT`（平台注入，缺省 3000）；`PUBLIC_URL` 非空时启动阶段调用 `setWebhook(${PUBLIC_URL}/telegram/webhook, { secret_token })`，幂等（每次启动重注册），失败只记日志、不阻断启动，Telegram 侧保留旧地址

迁移按单实例、低流量假设执行：每个实例启动都会跑一遍 `pnpm db:migrate`，多实例同时启动会并发执行迁移；0004 的 `CREATE INDEX` 会短暂持有表级 SHARE 锁（阻塞写入、允许读取），0006/0008/0009 的 `ADD COLUMN` 与 `CREATE TABLE`（0008 还有枚举类型 `chat_type` 的创建）会短暂持有 ACCESS EXCLUSIVE 锁，自用规模下几乎无感。0009 只新建 `subscription_links` / `subscription_members` 两张空表与索引，不 drop、不 rename、不改写旧 `subscriptions` 数据。实例数或写入量上来后，应把迁移拆成独立的发布步骤，或改用手工执行的 `CREATE INDEX CONCURRENTLY`。

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
| `OWNER_DEBUG_NOTIFY` | 否 | owner 判定 feed 开关：每条过审消息（含放行；信任名单直放的除外）私聊 owner 一条判定摘要。缺省开启；只接受 `true`/`false`，置 `false` 关闭。 |
| `APPEAL_SAMPLE_WRITEBACK` | 否 | 误伤样本回写开关（开发中功能）：`true` 启用，缺省与 `false` 关闭。关闭时管线不读误伤样本，few-shot 样例与内容白名单都不生效。 |
| `PUBLIC_URL` | 否 | 服务对外根地址；非空时启动阶段自动注册 webhook，空串或缺省跳过。 |
| `PORT` | 否 | HTTP 监听端口，缺省 3000；Zeabur 等平台会注入自己的值。 |
| `LLM_BASE_URL` | 否 | 云端 LLM 的 OpenAI 兼容服务根地址，不含 `/chat/completions`。 |
| `LLM_API_KEY` | 否 | 对应 API key。 |
| `LLM_MODEL` | 否 | 模型名，例如 `gpt-4o-mini`。 |
| `LLM_TIMEOUT_MS` | 否 | 复核请求超时（毫秒），缺省 30000。三个 `LLM_*` 缺任意一项即视为「未配置复核」，灰色地带按待复核处理。 |
| `MAINTENANCE_INTERVAL_MS` | 否 | 维护任务（日聚合重算 + 保留期清理）间隔（毫秒），缺省 3600000。 |

自动注册提交 `secret_token` 与显式的 `allowed_updates`（`message`、`edited_message`、`callback_query`、`channel_post`、`my_chat_member`、`chat_member`）：名单只在 `apps/bot` 维护一份，webhook 注册与长轮询共用，避免两个入口漂移导致漏收更新。`chat_member` 是 Phase 3b 订阅成员台账的事实来源，接收它需要 bot 在频道是管理员；不订阅没有处理器的其他类型，只会多几跳流量。切换部署形态（webhook ↔ 长轮询）时会用启动时的名单重新注册，无需手工覆盖。

### BotFather 前置步骤

按顺序完成，BotFather 的命令名与界面提示以实际回复为准（待实测回填）：

- [ ] 在 @BotFather 新建 bot，记下 `BOT_TOKEN`
- [ ] `/setprivacy` 选中该 bot，设为 `Disable`（否则读不到全群消息，审核管线收不到非命令消息）
- [ ] 把 bot 拉进目标群，并授予管理员权限（删除消息 / 禁言 / 封禁都需要）
- [ ] 频道场景：把 bot 设为频道管理员（`channel_post` 只在管理员身份下投递；频道帖只登记元数据、不审核）。若频道已绑定讨论组，把 bot 一并加入讨论组并授予删除消息权限——评论在讨论组里按讨论组自身的规则审核
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

Telegram 更新入口。请求头 `X-Telegram-Bot-Api-Secret-Token` 必须等于 `WEBHOOK_SECRET`，校验由 grammY 的 `webhookCallback` 完成（常数时间比较），不匹配返回 401。`allowed_updates` 由服务注册时显式写死为 `message`、`edited_message`、`callback_query`、`channel_post`、`my_chat_member`、`chat_member`（与长轮询入口同源，见「BotFather 前置步骤」上一节的手工注册命令）。

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

**误伤样本回写（开发中功能，默认关闭）。** 显式设置 `APPEAL_SAMPLE_WRITEBACK=true` 才启用（bot 与 server 两个进程都读它）；关闭时完全不读样本——复核不带参照样例、内容白名单也不生效。开启后：撤销结案的申诉会回写判定链路（Phase 2c）：灰色地带送审时，该群最近 90 天内被撤销过的消息摘录（非空、最多 5 条、最近优先）作为复核提示词的参照样例，降低同类误判复发；同一用户在 30 天内被撤销过的**同内容**消息再次出现时直接放行（不调复核、不执行动作，仅落事件与决策留痕）。样本读取只在「本会被处置」（规则分达到放行阈值）的消息上发生，失败按无样本降级。复核缓存指纹随之升到 v2。

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
      "chatType": "supergroup",
      "linkedChatId": null,
      "today": { "messageCount": 12, "actionCount": 3, "appealCount": 1, "overturnedCount": 0 },
      "last7d": { "messageCount": 80, "actionCount": 11, "appealCount": 4, "overturnedCount": 1 },
      "openAppeals": 2
    }
  ],
  "serverTime": "2026-09-23T12:00:00.000Z"
}
```

`chats` 按近 7 日 `actionCount` 降序，同分按 `chatId` 升序；`today` 与 `last7d` 按 UTC 切日，近 7 日含今天。`openAppeals` 是各群待处理申诉数。`chatType`（`group | supergroup | channel`）与 `linkedChatId` 是只读登记事实：频道行指向讨论组、讨论组行指向频道，未链接或尚未探测到时为 `null`；本批只暴露，界面消费留到下一批。

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
  "chatType": "supergroup",
  "linkedChatId": null,
  "language": "zh",
  "passThreshold": 0.3,
  "llmThreshold": 0.8,
  "muteDurationMinutes": 60,
  "rules": [
    { "id": "default-ad-wechat", "kind": "keyword", "pattern": "加微信", "score": 0.4, "actionHint": "delete", "enabled": true }
  ],
  "whitelist": [7000000001]
}
```

响应就是 `ChatConfig` 本体。`language` 目前只读（切换不在本批范围）；`chatType` / `linkedChatId` 同样是只读登记事实，本批只暴露不改。`whitelist` 是手工信任名单（名单内账号的消息直接放行，见「关键约定」）。未知群 `404 {"error":"chat_not_found"}`。

#### `PUT /api/panel/chats/:chatId/config`

```json
{
  "initData": "<Telegram.WebApp.initData>",
  "config": {
    "passThreshold": 0.3,
    "llmThreshold": 0.8,
    "muteDurationMinutes": 60,
    "rules": [{ "id": "default-ad-wechat", "kind": "keyword", "pattern": "加微信", "score": 0.4, "actionHint": "delete", "enabled": true }],
    "whitelist": [7000000001]
  }
}
```

全量替换规则、信任名单与阈值，保留 `title` / `chatType` / `linkedChatId` / `language`；保存后管线立即读到新配置。`rules` 里的 `id` 可省略或为空串，服务端分配 `custom-<8位十六进制>` 并随响应返回；`whitelist` 的重复项由服务端去重、不报错。面板保存与 bot 的元数据刷新走不同语句（前者全量、后者只清单列），并发时不会互相覆盖：元数据刷新永远不写规则列。

响应包装：GET 直接返回配置本体，PUT 把同一形状包在 `config` 键下，前端解析时不要混用。判定顺序是结构 → 鉴权 → 群存在 → 语义校验：未知群即使配置非法也先返回 `404 chat_not_found`。`details` 最多 50 条，超出时截断并以 `…等 N 条其他错误` 汇总。

- `200 {"config":{...}}`：与 GET 同形（注意外层包了 `config` 键），含服务端分配后的 id 与去重后的白名单
- `400 {"error":"invalid_request","details":[...]}`：逐条指出第几条规则的哪个字段。校验口径：`0 ≤ passThreshold ≤ llmThreshold ≤ 1`；`muteDurationMinutes` 为 1..43200 的整数；规则至多 100 条、id 不得重复；`kind` 取 `keyword | regex | link-domain | sender-name | custom-emoji | emoji-count | via-bot`；`pattern` 非空（纯空白同样拒绝），`regex` / `sender-name` 需能按 `u` 标志编译，`custom-emoji` / `emoji-count` 需为十进制计数，`via-bot` 不使用 pattern（允许空串）；`score ∈ [0,1]`；`actionHint` 取五个档位；`enabled` 为布尔；`whitelist` 必须为数组（缺字段同样拒绝）、元素为正安全整数用户 ID、去重后至多 50 条（重复项自动去重，不报错）
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

### 面板订阅接口（owner 专属，Phase 3b）

前缀 `/api/panel/subscriptions`，全部 owner-only。**凭据只从 `X-Telegram-Init-Data` header 读取**（URL 与 body 不携带；body 里出现 `initData` 字段会被严格校验拒绝），所有响应带 `Cache-Control: no-store`。日期是 UTC ISO-8601 或 `null`；`userId` 是安全整数 number，`linkId`/`requestId` 是 UUID。路径参数 `chatId` 必须是合法十进制字符串，未登记返回 404 `channel_not_found`，已登记但不是频道返回 400 `channel_required`。

| 方法与路径 | 输入 | 成功响应 |
| --- | --- | --- |
| `GET /channels` | `limit`（默认 50，1..100）、`cursor` | `200 {items:[ChannelDto],nextCursor,serverTime}`，只列已登记频道 |
| `GET /channels/:chatId` | — | `200 ChannelDetailsDto`（`visibility`/`canManageLinks`/`capabilityErrorCode`/`counts`/`serverTime`） |
| `GET /channels/:chatId/links` | `limit`、`cursor` | `200 {items:[LinkDto],nextCursor,serverTime}`，含占位/失败行 |
| `POST /channels/:chatId/links` | `{requestId,name,priceStars}` | `201 {link,replayed:false}`；同 requestId 已完成请求 `200 {link,replayed:true}` |
| `PATCH /channels/:chatId/links/:linkId` | `{name,expectedVersion}` | `200 {link}`（只改名，价格/周期不可编辑） |
| `POST /channels/:chatId/links/:linkId/revoke` | `{expectedVersion}` | `200 {link}`（含已撤销的重放） |
| `GET /channels/:chatId/members` | `limit`、`cursor` | `200 {items:[MemberDto],nextCursor,serverTime}` |

`name` 可空串、按 Unicode code point 至多 32、保留原文不 trim；`priceStars` 是 1..10000 的整数；周期由服务端固定 `2592000`，客户端不传；POST/PATCH 严格拒绝额外字段。分页游标是不透明 base64url JSON（>1024 字符、跨资源、跨频道、坏字段一律 400 `invalid_cursor`），links 按 `(createdAt,id)` 倒序、members 按不可变 `(firstObservedAt,id)` 倒序；counts 用 SQL 聚合，不受分页影响。频道详情与变更前会用 `getChat` + `getChatMember(bot)` 校验可见性与权限（获取失败为 `unknown` 且 `canManageLinks=false`，不把未知当私有），变更权限不足 403 `bot_permission_required`。

错误统一为 `{error,message,retryable,requestId?}`：400 `invalid_request|invalid_cursor|channel_required`；401 `init_data_invalid`；403 `forbidden|bot_permission_required`；404 `channel_not_found|link_not_found`；409 `request_conflict|operation_in_progress|create_outcome_unknown|link_revoked|version_conflict|create_failed`；502 `telegram_failed|telegram_outcome_unknown|persistence_after_telegram_failed`；其他故障 500 `internal_error`。`retryable` 只表示同一请求可安全重查/重试，不表示可以换 requestId 再建。路由层只按精确方法匹配：非 GET/POST/PUT/PATCH 的请求不会回退成 GET。

### `GET /app/*`

Mini App 静态产物，对应 `apps/web/dist`。找不到文件且路径没有扩展名时回退到 `index.html`，路径解析后必须在产物目录内（`..` 与百分号编码逃逸一律 404）。跑 `pnpm build:web` 之前访问会得到 404。

### initData 校验口径

`secret = HMAC_SHA256(key="WebAppData", message=bot_token)`，`hash = HMAC_SHA256(key=secret, message=data_check_string)`，`data_check_string` 是**除 `hash` 外全部收到字段**（含 `signature`）按 `key=value` 排序后用换行连接。「排除 hash 与 signature」是第三方 Ed25519 校验（另一串字符串）的规则，混用会让所有带 signature 的真实 initData（Bot API 8.0 起客户端一律携带）验签失败。`auth_date` 与当前时间相差超过 1 小时即拒绝（允许 60 秒的时钟快偏移）；Mini App 每次打开都会拿到新的 initData，正常使用中用户无感。

## 关键约定

**正文默认不留存，处置对象留摘录。** `message_events` 只有 `content_hash` 与特征列（是否有链接、媒体类型、长度、自定义表情数、表情总数、是否经内联机器人发送）；唯一的正文落地形态是 `sample_text`，一条被判非放行的消息的原文摘录（≤280 字符），用于申诉复核与事后复盘。它由 SQL 条件强制：只有同事件存在非 `pass` 决策时才允许写入，放行消息的正文没有任何写入路径。

**归一化是所有匹配的前提。** 文本先过 `normalize`，规则 pattern 按归一化后的形态编写（小写、简体、无拆词标点）。`normalize` 会把「加v」改写成「加微信」，按原始写法写规则永远匹配不上，新增规则前先跑一遍归一化。发送者身份（显示名与 `@用户名`）走同一套归一化，`kind: 'sender-name'` 的规则匹配的是身份而非正文；身份只存在于运行时，不落库。绕过词表在 `packages/core/src/normalize-map.ts`，扩充只改数据。

**双阈值决定要不要花钱。** `passThreshold` 以下直接放行；`llmThreshold` 以上直接按命中的规则处置；只有落在中间的样本才调用 LLM。灰色地带没拿到复核结论时返回 `warn`，不执行破坏性动作。

**规则、阈值与信任名单可在面板里编辑。** 规则集、双阈值、禁言时长与信任名单在 Mini App 面板的「规则」页签编辑，保存后立即生效（管线每条消息读配置）。保存边界会挡住坏数据（阈值乱序、坏正则、非法枚举、超量规则、非法白名单等）并逐条指出第几条规则的哪个字段、第几个白名单元素，与 README 既有口径「规则编译失败在保存接口暴露」一致。

**信任名单直接放行。** 每个群/频道一份手工信任名单（上限 50 个账号、服务端去重）：名单内账号的消息在配置载入后直接落一条 `pass` 决策（score 0、signals 空）并返回，不查误伤样本、不跑规则、不调复核、不施加动作；新消息与编辑消息同样适用，事件与决策照常落库供回看。它与内容白名单（误伤样本）互不影响，二者可以同时存在。名单命中不走审核链路，**也不发 owner 判定 feed**——信任名单的语义就是不逐条打扰。

**默认配置只在群/频道首次登记时写入。** 新对话拿到 15 条默认规则（含 `default-emoji-flood`：表情总数 ≥6；`default-inline-bot`：经内联机器人发送，pattern 不使用），此后配置以数据库为准；已登记的群不会自动追加新默认规则，需要时在面板手动添加。频道与讨论组各自登记、各自成套配置，互不套用（详见「频道与讨论组（Phase 3a）」）。表情总数把普通 Unicode 表情也计入（`custom-emoji` 只覆盖付费自定义表情），按用户感知每个表情恰计一次（ZWJ 序列如家庭表情计 1，不再按码位拆开）；两者叠加后有意的语义收紧：≥6 个自定义表情会同时命中 `default-emoji-burst` 与 `default-emoji-flood`（0.8 直接处置）。

**重复投递不重复处置。** 事件 id 由 `(chatId, messageId)` 派生（编辑消息附加 `edit:${edit_date}:${内容哈希前 16 位}` 判别符：同一秒内不同内容的编辑各自成事件，编辑回退到早前内容时复用当时的事件 id、不再重审），决策 id 由事件 id 派生，落库用 `on conflict do nothing`；执行侧再叠一层 `eventId + action` 的进程内幂等闸门与 `moderation_decisions.executed` 回填。Telegram 重投递同一 update 的效果是「什么都不再发生」。

**不变量尽量进 DDL。** 阈值必须有序、`mute` 才带解禁时刻、置信度与分数限定在 0..1、结案状态与结案时间/结案人必须一致、一条处置至多一条申诉，这些都写成 CHECK 与唯一索引，绕过应用的写入同样会被拒绝。

**通知不做人为丢弃。** 警示语与处置通知总是直接尝试发送：密集时不做本地节流、也不因频率跳过，由 Telegram 的 429 退避兜底（`retry_after` + 抖动重试，见 `telegram-call.ts`）；发送失败或退避耗尽按「通知可丢」记日志，动作本身不受影响。

**依赖冻结。** 依赖在脚手架阶段一次性装齐，后续 lane 不新增外部依赖。需要新库时先改根 `package.json` 与各包 `package.json`，再重跑 `pnpm install`。

## 频道与讨论组（Phase 3a）

**登记与刷新。** bot 把所在的群/频道写进 `chats`：新群第一条消息、`my_chat_member`（bot 被加入或升为管理员）、`channel_post` 三条入口都会登记，登记只走 `ChatRepo.register`——`chatId` 已存在时什么都不做，绝不用默认配置覆盖 owner 已保存的规则。已登记行的元数据（标题、类型、linked 关系）走独立的 `ChatRepo.updateMetadata` 单列 UPDATE，同样不碰规则与阈值。

**管理员权限。** 删除/禁言/封禁都要 bot 在目标群是管理员；频道场景还要把 bot 设为频道管理员才会收到 `channel_post`。评论在讨论组里审核，因此讨论组里也要给 bot 删除消息的权限。

**频道帖只登记、不审核。** `channel_post` 不产生 `message_events`、不落帖子内容、不执行动作，只登记频道元数据（类型、标题、linked 讨论组）。

**评论归属讨论组。** 频道绑定的讨论组里的评论就是讨论组的普通消息：发送者是评论用户，按该讨论组自己的配置判定与处置（讨论组首次收到消息时登记，拿自己的默认规则）。频道配置不会应用到讨论组，反之亦然——判定只看消息所在聊天的 `chatId`。频道自动转发到讨论组的根帖（`is_automatic_forward`）不是用户发言，一律跳过，不产生事件与处置；普通用户评论不受影响。私聊评论深链的新格式（`t.me/<channel>/<post>?comment=<id>`）不在本批范围，既有链接回退（`t.me/c/...` 深链）保持不变。

**linked discussion 关系。** 频道 ↔ 讨论组是 Telegram 的 linked chat：频道行 `linkedChatId` 指向讨论组，讨论组行指向频道。更新里不带这个字段（只有 `getChat` 的完整聊天信息有），因此只在关系缺失时探测一次，并按聊天记录冷却窗口（内存表，6 小时），已有值绝不重复请求——不会出现「每条频道帖都打一次 getChat」。`getChat` 失败按可恢复降级处理：保留已知信息、只记一条不含 token 的脱敏日志，之后（冷却期外）由新的频道帖、成员变更或评论触发再试。已知边界：链接**被解除**时不会主动清空已记录的值（没有对应的更新事件，当前也没有消费方），需要时手工改库。

**历史类型待刷新。** `chats.chat_type` 是迁移新列，历史行按兼容默认值 `supergroup` 落库；真实类型由后续的登记/刷新路径修正（新消息、`my_chat_member`、`channel_post` 任一入口都会带来权威的 `chat.type`）。看到历史群 `chatType` 不准时，等下一次消息或成员变更即可，不需要手工改库。这些刷新都依赖实际收到的更新，**不承诺实时或最终一致**：bot 不在场、链接被解除、群被改名等没有对应更新时，记录会保持旧值，需要准确值以 Telegram 侧为准。

**旧订阅门禁表仍保留、不再发展。** Phase 1 的 `subscriptions` 表（用户 + 链接 + 非空到期日捆绑）与旧类型、旧数据都不删不改、不自动迁移；Phase 3b 的新台账是独立的 `subscription_links` + `subscription_members`（见「频道订阅（Phase 3b）」）。旧表有数据是合法状态，新台账不把它当既有成员依据。

## 频道订阅（Phase 3b）

服务端能力：Bot 自建**付费频道**邀请链接的创建、改名、撤销；由 `chat_member` 事件与定期对账维护的**成员观测台账**；owner 面板通过 HTTP 契约（见「面板订阅接口」）消费。**Telegram 原生管理订阅访问**：本地任何到期时间、撤链、查询失败都不会触发 ban/kick/restrict，本服务的相关代码只读成员快照、不调用任何权限处置接口。

**数据模型。** 新表 `subscription_links`（幂等创建占位 + 完整邀请链接 + 操作占位）与 `subscription_members`（已知成员的状态、到期观测值、纳入证据、事件高水位、对账控制字段）。旧 `subscriptions` 表保留但不参与新台账。邀请链接只保存在数据库与 owner 面板响应里，绝不进日志、异常对象或监控标签。

**创建（不套自动重试）。** 客户端带 `requestId` 提交；服务端先落持久化占位（`creating`），只有拿到占位的调用者才会向 Telegram 发一次创建。同一 `requestId` 同载荷重试直接重放已保存结果；不同载荷返回 409；占位 60 秒仍未确认即视为 `create_unknown` 且**绝不自动重发**。Telegram 明确拒绝记 `create_failed`；网络超时/进程崩溃等不确定结果返回 502 并提示「可能已创建，先去频道邀请链接人工核查」——不提供虚假的 exactly-once 承诺，也不自动生成新 requestId 重试。

**改名与撤销。** 只操作本服务保存且属于路径频道的完整链接（不接受客户端提交任意 inviteLink）。改名只发送 name；撤销先由 Telegram 确认「原链接 is_revoked=true」再落本地状态。改名/撤销走数据库条件写（expectedVersion + 操作占位），冲突返回 409；**撤销是终态**，迟到的改名结果不能让已撤销链接复活。DB 提交失败不返回成功。

**成员纳入与语义。** 只处理频道成员事件，身份取 `new_chat_member.user.id`（`from` 是操作人）。新行必须有订阅证据：有效的 `ChatMemberMember.until_date`，或加入时的 `invite_link` 与本 Bot 新台账中的付费链接完整匹配（外部管理员创建的链接会被掩码，无法关联——这是 Telegram 的限制）；无证据的新免费成员不纳入。`expiresAt` 是「最新成功快照观测到的到期时间」，缺失只表示这次没观测到，不代表无限期或付款失效；`left` 只表示观测到离开，不用 `expired` 表述；`member` 计数是「最后一次观测仍在频道」的已知成员，不是付费会员总数、不是到账或收入。公开频道的付费链接不阻止任何人免费直接加入。

**定期对账。** server 进程每 60 秒跑一轮 single-flight 对账（独立生命周期，shutdown 时停止）：每轮最多 claim 50 行、最多 4 个并发、单次 `getChatMember` 10 秒超时、租约 60 秒；按 `lastCheckedAt ASC NULLS FIRST, id ASC` 公平轮转，失败也推进尝试时刻；成功结果用 CAS（token + version）落库，查询期间有事件写入就丢弃结果；429 停止本轮新派发并释放未派发的租约。对账只读 `getChatMember`，不调用权限处置接口。Telegram 不提供精确的服务器快照时间，短暂观测不一致由下一轮修正，不宣称强一致。

**已知边界。** 不枚举历史全量订户、不保证所有续订即时入账、不提供财务证明、不自动恢复失去响应的创建结果（需 owner 到 Telegram 核查孤儿链接）、撤销对既有订阅的影响以 Telegram 为准、不用本地时间过期做任何权限维护。真机（真实 PG 迁移与真实 Telegram 调用）尚未验证，见「Phase 1 的已知边界」。

## Phase 1 的已知边界

- 误伤样本回写（默认关闭，开启方式见环境变量 `APPEAL_SAMPLE_WRITEBACK`）：启用后复核缓存的判定指纹升到 v2（把样例纳入键），旧指纹的缓存不再命中，等 30 天保留期清理自然消失；内容白名单的自动放行窗口固定 30 天、样本回看窗口 90 天，都不随群配置调整。
- 频道与讨论组：频道帖只登记元数据（`channel_post` 不审核、不落内容），评论按讨论组自身规则审；订阅链接与成员观测见「频道订阅（Phase 3b）」。旧 `subscriptions` 表保留、未迁移。
- 日聚合按 UTC 切日：`ChatConfig` 里没有时区字段，跨时区部署的看板边界会有一天偏差，比值类指标不受影响。
- 规则集、阈值、禁言时长与信任名单可以在面板里编辑，也可以直接改数据库或走 `ChatRepo.upsert`：两处没有版本协调（单 owner 最后写入胜），并发编辑面板与数据库不会互相提示。
- 信任名单的读取口径刻意宽松：`chats.whitelist` 不是正安全整数数组时（含混入负数、小数、字符串）读取侧整体回落空数组，坏数据只让名单失效、不阻断判定；上限 50 只在面板写入边界强制，直接写库可以超过，领域类型不承诺该不变量的运行时成立。
- 单进程假设：幂等闸门在进程内，多实例部署前需要把它挪到共享存储。
- 累犯计数在并发处理下的阈值竞态：`countPriorViolations` 读的是已落库的决策数，同一用户两条消息被并发处理时，两边都可能数到「还差一条」而不加重档位（漏加重）。窗口内累计三次的判定因此是尽力而为，不保证严格；要严格需要给 `(chatId, userId)` 加锁或改成数据库侧的原子计数。
- 时间源没有贯穿 `decide`：`mute` 的解禁时刻由 `packages/core` 的 `decide` 直接读 `Date.now()` 算出，不经过管线注入的 `now`。正常运行时两者是同一个挂钟，影响只在测试与本地跑批：要用自定义时间源断言 `mute.until` 时得先冻结 `Date`。
- 同一消息的每次编辑产生独立事件与决策，频繁编辑会加速累犯计数（设计取舍：每次编辑是独立违规事件，不合并计数）。判别符是 `edit:${edit_date}:${内容哈希前 16 位}`：同一秒内不同内容的编辑各自成事件；编辑回退到早前内容时复用当时的事件 id，跳过重审（该状态已审过，代价是回退后不会按新语境重新判定）。
- 补偿重投递窗口内处置通知可能重复（Telegram 重投递、崩溃恢复重跑执行器时各发一条），通知引用只记最后一条，申诉生命周期的编辑作用于它，更早的那条留在原地。
