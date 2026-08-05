import { defineConfig } from 'vitest/config';

// UI 测试（ink-testing-library）的 fake stdout 无 isTTY，chalk 会据此关闭颜色输出。
// 强制开启颜色，使 <Text color={...}> 产生 ANSI 转义码，供 lastFrame() 子串断言。
// 现有非 UI 测试不涉及颜色断言，不受影响。
export default defineConfig({
  test: {
    environment: 'node',
    env: {
      FORCE_COLOR: '1',
    },
  },
});
