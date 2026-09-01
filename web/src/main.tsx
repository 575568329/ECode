import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { consumePairingHash } from './relay'
import './index.css'

// R2：配对深链消费（#pairing= → relay 配置+token 落地、剥 hash）——必须先于 App 挂载
consumePairingHash()

// 性能基准页（dev-only）：?perf=1 进入——生产构建 DEV=false 走死分支被裁剪
if (import.meta.env.DEV && new URLSearchParams(location.search).has('perf')) {
  void import('./perf/main-perf').then((m) => m.mountPerf())
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

// M13-W7：SW 注册（生产构建才注册——dev 模式的 HMR 与 SW 缓存互斥）
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  // 相对路径：relay 子路径托管（/ecode/）下绝对 /sw.js 会落到反代根（404/HTML——SW 注册必败）
  void navigator.serviceWorker.register('sw.js')
}
