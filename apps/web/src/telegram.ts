/**
 * Telegram WebApp 桥接。只声明本页用到的最小接口面，不引入完整 SDK 类型包。
 * 脚本由 index.html 从 telegram.org 加载；在 Telegram 之外打开时 window.Telegram 不存在，
 * 访问点统一返回 null，由调用方决定降级行为（本页按「缺少参数」处理）。
 */

export interface WebAppUnsafe {
  start_param?: string
}

export interface TelegramWebApp {
  /** 签名后的身份凭据，原样随请求带给后端校验。 */
  initData: string
  initDataUnsafe: WebAppUnsafe
  /** 告知 Telegram 页面就绪，可以收起启动占位。 */
  ready(): void
  /** 把 webview 展开到全高，避免半截视口里做表单。 */
  expand(): void
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp }
  }
}

/** 取 WebApp 实例；不在 Telegram 内打开时为 null。 */
export function getWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null
}

/**
 * 从页面 URL 取 Telegram 启动参数。
 *
 * 官方把启动参数放在 `#tgWebAppData=…`（hash 形态）或 `?tgWebAppStartParam=…`（query 形态），
 * 由 telegram-web-app.js 解析进 `window.Telegram`。脚本没加载成时（网络拦截、加载失败），
 * 这里直接读 URL 兜底，两种形态都认。值按 decodeURIComponent 还原一次。
 *
 * @param name 参数名。
 * @returns 参数值；不存在时为 null。
 */
function launchParam(name: string): string | null {
  const fromQuery = new URLSearchParams(window.location.search).get(name)
  if (fromQuery != null && fromQuery !== '') return fromQuery

  for (const pair of window.location.hash.replace(/^#/u, '').split('&')) {
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    const key = decodeURIComponent(pair.slice(0, separator))
    if (key !== name) continue
    const raw = pair.slice(separator + 1)
    if (raw === '') return null
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return null
}

/** 取申诉链接参数（startapp=decisionId）。t.me 直链经 Telegram 转发后改名为 tgWebAppStartParam，几种形态都认。 */
export function getDecisionId(): string | null {
  const fromTelegram = getWebApp()?.initDataUnsafe.start_param
  if (fromTelegram != null && fromTelegram !== '') return fromTelegram
  return launchParam('tgWebAppStartParam') ?? launchParam('start_param') ?? launchParam('startapp')
}

/** 取签名身份凭据。优先用 telegram-web-app.js 解析好的 initData，脚本缺席时回退到 URL 的 tgWebAppData。 */
export function getInitData(): string {
  const fromSdk = getWebApp()?.initData
  if (fromSdk != null && fromSdk !== '') return fromSdk
  return launchParam('tgWebAppData') ?? ''
}
