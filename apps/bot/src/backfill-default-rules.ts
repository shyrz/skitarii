/**
 * 回填脚本：给既有的群/频道配置补齐 `DEFAULT_RULES` 中缺失的默认规则。
 *
 * 为什么需要它：默认规则只在群首次登记时由 `defaultChatConfig` 写入，之后新增的默认规则不会
 * 出现在既有配置里（用户群因此漏判）。现在通常由部署入口 `deploy/entrypoint.sh` 在每次启动前
 * 自动以 `--apply` 执行（幂等），新增默认规则随下次部署生效，无需手动运行；本脚本也可手动执行。
 *
 * 幂等且只补不删：按 `id` 判断缺失，已存在的规则（包括 owner 手改过的同名规则）与顺序原样保留，
 * 缺失项按 `DEFAULT_RULES` 的顺序追加到尾部；删掉的默认规则会在下次部署被重新补上，要屏蔽某条
 * 规则请在面板「停用」。
 *
 * 默认 dry-run：只打印每群将追加的规则 id 与汇总，不写库；加 `--apply` 才写入。写入只经
 * `updateRulesConfig` 更新 `rules`，白名单、阈值与元数据以现值原样回传，不会被改动。
 * 单群失败只记录并继续，最后按是否存在失败决定退出码（有失败为 1）；部署入口容忍非 0，
 * 补齐失败只告警、不阻塞服务启动。
 *
 * 运行方式（在仓库根目录；需要环境变量 DATABASE_URL，连接串不会出现在日志里）：
 *   pnpm --filter @skitarii/bot exec tsx src/backfill-default-rules.ts [--apply]
 * 部署入口实际的工作目录是 apps/server：
 *   node --import tsx ../bot/src/backfill-default-rules.ts --apply
 */

import { pathToFileURL } from 'node:url'
import type { Rule } from '@skitarii/core'
import { createDb, createPgRepos } from '@skitarii/db'
import { DEFAULT_RULES } from './defaults.js'
import { createLogger } from './logger.js'

const logger = createLogger('backfill-default-rules')

/**
 * 计算既有规则集里缺失的默认规则。
 *
 * 判据只有 `id`：同 id 的规则即使被改过 `pattern` / `score` 也算已覆盖，回填不会覆盖 owner 的调整。
 *
 * @param existing 该群当前的规则集（顺序原样保留）。
 * @returns 缺失的默认规则副本，顺序与 `DEFAULT_RULES` 一致；无缺失时为空数组。
 */
export function missingDefaultRules(existing: readonly Rule[]): Rule[] {
  const presentIds = new Set(existing.map((rule) => rule.id))
  return DEFAULT_RULES.filter((rule) => !presentIds.has(rule.id)).map((rule) => ({ ...rule }))
}

/**
 * 回填全部群配置。
 *
 * @param apply `true` 写库；`false` 只预览。
 * @returns 进程退出码：有失败为 1，否则为 0。
 */
async function runBackfill(apply: boolean): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined || databaseUrl === '') {
    logger.error('未设置 DATABASE_URL，无法连接数据库')
    return 1
  }

  const handle = createDb(databaseUrl)
  let failed = 0
  let affected = 0
  let appended = 0
  let total = 0

  try {
    const repos = createPgRepos(handle.db)
    const chats = await repos.chats.listAll()
    total = chats.length

    for (const chat of chats) {
      const missing = missingDefaultRules(chat.rules)
      if (missing.length === 0) continue

      affected += 1
      appended += missing.length
      const ids = missing.map((rule) => rule.id).join(', ')

      if (!apply) {
        logger.info(`${chat.chatId}「${chat.title}」将追加 ${missing.length} 条：${ids}`)
        continue
      }

      try {
        // updateRulesConfig 是全量写：白名单与阈值以现值原样回传，本脚本的意图只有 rules。
        await repos.chats.updateRulesConfig(chat.chatId, {
          rules: [...chat.rules, ...missing],
          whitelist: chat.whitelist,
          passThreshold: chat.passThreshold,
          llmThreshold: chat.llmThreshold,
          muteDurationMinutes: chat.muteDurationMinutes,
        })
        logger.info(`${chat.chatId}「${chat.title}」已追加 ${missing.length} 条：${ids}`)
      } catch (error) {
        // 单群失败不阻断其余群，失败计数决定最终退出码。
        failed += 1
        logger.error(`${chat.chatId}「${chat.title}」写入失败，跳过该群`, error)
      }
    }
  } catch (error) {
    logger.error('读取群配置失败', error)
    return 1
  } finally {
    await handle.close()
  }

  if (affected === 0) {
    logger.info(`共 ${total} 群，均无缺失默认规则，无需操作`)
  } else if (apply) {
    logger.info(
      `完成：共 ${total} 群，更新 ${affected - failed} 群、追加 ${appended} 条${failed > 0 ? `，失败 ${failed} 群` : ''}`,
    )
  } else {
    logger.info(`dry-run：共 ${total} 群，${affected} 群存在缺失、待追加 ${appended} 条；确认后加 --apply 写入`)
  }
  return failed > 0 ? 1 : 0
}

/** 仅在被 tsx 直接执行时跑回填；测试 import 本文件只取纯函数，不碰数据库。 */
const executedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (executedDirectly) {
  process.exitCode = await runBackfill(process.argv.includes('--apply'))
}
