import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'

/**
 * Mini App 挂载入口。
 * `#root` 由 index.html 提供，缺失说明 HTML 与入口脱节，直接抛出比静默白屏更好排查。
 */
const container = document.getElementById('root')
if (container === null) {
  throw new Error('缺少 #root 容器，检查 index.html')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
