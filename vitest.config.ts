import { defineConfig } from 'vitest/config'

// 根仓测试范围：tests/（镜像 src）。web/ 独立包自带 vitest（npm test 于 web/ 内跑——
// 依赖解析走 web/node_modules），根跑不拾取（默认 include 会吞 web/tests，排除之）
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'web/**'],
  },
})
