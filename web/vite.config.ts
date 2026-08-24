import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// M13-W5：daemon 托管形态——build 产出到 web/dist（serveMode GET / 直接吐）；
// dev 模式代理到本机 daemon（127.0.0.1 随机端口需手动 ECODE_SERVE_PORT 固定后对准）
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist' },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8765', changeOrigin: false },
    },
  },
})
