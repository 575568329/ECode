import { createRoot } from 'react-dom/client'
import { PerfBench } from './PerfBench'

// 性能基准页挂载：不加 StrictMode（dev 双渲染会污染 commit 计数）
export function mountPerf(): void {
  const el = document.getElementById('root')
  if (el !== null) {
    createRoot(el).render(<PerfBench />)
  }
}
