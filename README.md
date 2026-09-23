# skitarii

自用 Telegram 群组/频道消息审核工具。规则层先筛，低置信样本才送云端 LLM 复核，动作执行结果与申诉闭环都留痕。

当前进度：Phase 1 后端闭环已完成。审核管线、动作执行（幂等 + 限流退避）、Mini App 申诉 API、owner 处理流程、日聚合与保留期清理调度都在跑，调度器里还带两条兜底扫描：未执行决策的补偿执行与未送达 owner 通知的补发；Mini App 界面与频道/订阅能力归后续阶段。

## 结构

```
packages/core   领域层。类型权威、归一化、规则匹配、处置决策，纯函数，无 I/O 无框架依赖
packages/db     Postgres 存储层。drizzle schema、迁移、连接工厂、7 个仓储的 PG 实现与内存实现
packages/llm    云端 LLM 复核。OpenAI 兼容协议的调用实现、提示词、按内容哈希的缓存包装
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
   │ 1 落 MessageEvent（id 由 chatId+messageId 派生，重投递幂等）                              │
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
   群内处置通知 + inline 申诉按钮（${MINI_APP_URL}?startapp=${decisionId}）
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
- 同一个 `contentHash` 的复核结论在 `llm_cache` 里复用（30 天后清理）。缓存只替代复核这一步，规则命中与 `decide` 每次都照常执行，因此群与群之间的配置差异不会被抹平。

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
pnpm dev:server           # HTTP 服务，默认 8080；webhook 模式下由它驱动 bot
pnpm dev:web              # Mini App 开发服务器，5173
```

两个进程的启动脚本带 `--env-file-if-exists=../../.env`，因此 `pnpm dev:*`、`pnpm start` 会自动读取仓库根目录的 `.env`，文件不存在也不报错。已有环境变量优先于文件内容，生产部署按常规注入环境变量即可。Mini App 由 Vite 提供开发服务器，vite 自己读 `.env`。

生产部署建议只跑 `apps/server`：它挂 Telegram webhook、托管 Mini App 产物，并复用同一个 `createBot` 运行时。同时跑 `pnpm dev:bot`（长轮询）会与 webhook 抢更新，两者只选一只。

`pnpm db:migrate` 与 `pnpm db:generate` 不读 `.env` 文件，需要把 `DATABASE_URL` 放在环境里：

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/skitarii pnpm db:migrate
```

webhook 注册（一次性）：

```bash
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=https://your-host/telegram/webhook" \
  -d "secret_token=${WEBHOOK_SECRET}" \
  -d "allowed_updates=[\"message\",\"callback_query\"]"
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm typecheck` | 所有工作区的 `tsc --noEmit`（strict，含 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`） |
| `pnpm test` | vitest 全量测试；单包用 `pnpm vitest run packages/core` |
| `pnpm build:web` | 构建 Mini App，产物在 `apps/web/dist` |
| `pnpm db:generate` | 按 schema 生成迁移到 `packages/db/drizzle` |
| `pnpm db:migrate` | 应用迁移 |

## HTTP 接口

Mini App 的申诉接口是冻结契约，界面按这里实现。所有时间字段都是 ISO 8601 字符串（`JSON.stringify` 的 Date 形态）。

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

提交成功后 bot 会私聊 owner 一条通知，附「维持原处置 / 撤销并恢复」两个按钮。撤销会回滚权限（mute 解禁、ban 解封），并把申诉置为 `overturned`，写 `resolvedAt` 与 `resolvedBy`；维持置为 `upheld`。已结案的申诉不会被重复点击翻转。

通知没被 Telegram 接受时（owner 从未与 bot 私聊过、网络抖动）不会让提交失败：这条申诉留在 `notified_at` 为空的状态，调度器的补发扫描会重试。代价是极端情况下可能收到重复的同一条提醒，而不会出现「申诉静默地没人处理」。

### `GET /app/*`

Mini App 静态产物，对应 `apps/web/dist`。找不到文件且路径没有扩展名时回退到 `index.html`，路径解析后必须在产物目录内（`..` 与百分号编码逃逸一律 404）。跑 `pnpm build:web` 之前访问会得到 404。

### initData 校验口径

`secret = HMAC_SHA256(key="WebAppData", message=bot_token)`，`hash = HMAC_SHA256(key=secret, message=data_check_string)`，`data_check_string` 是除 `hash` 与 `signature` 外的字段按 `key=value` 排序后用换行连接。`signature` 必须排除，否则带它的 initData 一律验不过。`auth_date` 与当前时间相差超过 1 小时即拒绝（允许 60 秒的时钟快偏移）；Mini App 每次打开都会拿到新的 initData，正常使用中用户无感。

## 关键约定

**正文默认不留存，处置对象留摘录。** `message_events` 只有 `content_hash` 与特征列；唯一的正文落地形态是 `sample_text`，一条被判非放行的消息的原文摘录（≤280 字符），用于申诉复核与事后复盘。它由 SQL 条件强制：只有同事件存在非 `pass` 决策时才允许写入，放行消息的正文没有任何写入路径。

**归一化是所有匹配的前提。** 文本先过 `normalize`，规则 pattern 按归一化后的形态编写（小写、简体、无拆词标点）。`normalize` 会把「加v」改写成「加微信」，按原始写法写规则永远匹配不上，新增规则前先跑一遍归一化。绕过词表在 `packages/core/src/normalize-map.ts`，扩充只改数据。

**双阈值决定要不要花钱。** `passThreshold` 以下直接放行；`llmThreshold` 以上直接按命中的规则处置；只有落在中间的样本才调用 LLM。灰色地带没拿到复核结论时返回 `warn`，不执行破坏性动作。

**重复投递不重复处置。** 事件 id 与决策 id 都由 `(chatId, messageId)` 派生（确定性的 uuid），落库用 `on conflict do nothing`；执行侧再叠一层 `eventId + action` 的进程内幂等闸门与 `moderation_decisions.executed` 回填。Telegram 重投递同一 update 的效果是「什么都不再发生」。

**不变量尽量进 DDL。** 阈值必须有序、`mute` 才带解禁时刻、置信度与分数限定在 0..1、结案状态与结案时间/结案人必须一致、一条处置至多一条申诉，这些都写成 CHECK 与唯一索引，绕过应用的写入同样会被拒绝。

**出站消息限流。** 每个群一个令牌桶（容量 3、20 条/分钟），警示语与处置通知是可丢消息，桶空时跳过发送；动作本身不受限流影响，它只受 Telegram 的 429 约束，按 `retry_after` 退避重试。

**依赖冻结。** 依赖在脚手架阶段一次性装齐，后续 lane 不新增外部依赖。需要新库时先改根 `package.json` 与各包 `package.json`，再重跑 `pnpm install`。

## Phase 1 的已知边界

- 白名单与误伤样本的 few-shot 回写推迟到 Phase 2（申诉结案后的样本沉淀先靠 `appeals` 表与 `signals`）。决策表里已经存下了判定依据，不需要新表。
- 频道消息（`channel_post`）与 linked discussion 评论、订阅门禁（`subscriptions` 表已就位）按计划留到 Phase 3。
- 日聚合按 UTC 切日：`ChatConfig` 里没有时区字段，跨时区部署的看板边界会有一天偏差，比值类指标不受影响。
- 规则集的修改目前只能改数据库或走 `ChatRepo.upsert`，Mini App 的配置面板在 Phase 2。
- 单进程假设：幂等闸门与令牌桶都在进程内，多实例部署前需要把它们挪到共享存储。
- 累犯计数在并发处理下的阈值竞态：`countPriorViolations` 读的是已落库的决策数，同一用户两条消息被并发处理时，两边都可能数到「还差一条」而不加重档位（漏加重）。窗口内累计三次的判定因此是尽力而为，不保证严格；要严格需要给 `(chatId, userId)` 加锁或改成数据库侧的原子计数。
- 时间源没有贯穿 `decide`：`mute` 的解禁时刻由 `packages/core` 的 `decide` 直接读 `Date.now()` 算出，不经过管线注入的 `now`。正常运行时两者是同一个挂钟，影响只在测试与本地跑批：要用自定义时间源断言 `mute.until` 时得先冻结 `Date`。
