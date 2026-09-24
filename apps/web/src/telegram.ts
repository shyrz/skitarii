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

/** 取申诉链接参数（startapp=decisionId）。 */
export function getDecisionId(): string | null {
  // 优先取 Telegram 注入的 start_param（t.me 直链形态），再回退到查询串（按钮地址自带的 ?startapp=）。
  // 只读其一的话，另一种入口形态拿不到 decisionId，申诉页会当成「缺参数」。
  const fromTelegram = getWebApp()?.initDataUnsafe.start_param
  if (fromTelegram != null && fromTelegram !== '') return fromTelegram
  const fromQuery = new URLSearchParams(window.location.search).get('startapp')
  return fromQuery != null && fromQuery !== '' ? fromQuery : null
}
