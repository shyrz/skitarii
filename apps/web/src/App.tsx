import { AppealApp } from './AppealApp.js'
import { PanelApp } from './panel/PanelApp.js'
import { getDecisionId } from './telegram.js'

/**
 * 路由分流（phase2-spec §4）：
 * - startapp=<uuid> → 申诉视图（文案、交互、版式保持原样）；
 * - startapp=panel（字面量）或没有 startapp → owner 管理台；
 * - 其余无法识别的值按申诉视图处理，由后端 404 落到「没有找到这条处理记录」屏，
 *   不在前端做 uuid 校验，避免规则与后端漂移。
 */
export function App() {
  const param = getDecisionId()
  if (param !== null && param !== 'panel') return <AppealApp />
  return <PanelApp />
}
