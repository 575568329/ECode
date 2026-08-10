// vision-fallback.ts —— 图片输入降级测试
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveImageStrategy } from '../src/vision-fallback.js';

// Mock config 依赖（resolveImageStrategy 调 hasCapability）
vi.mock('../src/providers/config.js', () => ({
  hasCapability: vi.fn((model: string, cap: string) => {
    if (cap === 'vision') return model === 'glm-4v-plus';
    if (cap === 'tools') return true;
    return false;
  }),
}));

const MOCK_IMAGE = {
  type: 'base64' as const,
  mediaType: 'image/png',
  data: 'iVBORw0KGgo=',
};

describe('resolveImageStrategy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- 策略 ① inline：模型支持 vision ----

  it('模型支持 vision + 有图片 → inline，无 llmHint', () => {
    const result = resolveImageStrategy('glm-4v-plus', [MOCK_IMAGE]);
    expect(result.strategy).toBe('inline');
    expect(result.warning).toBeUndefined();
    expect(result.llmHint).toBeUndefined();
  });

  it('模型支持 vision + 无图片 → inline（no-op）', () => {
    const result = resolveImageStrategy('glm-4v-plus', undefined);
    expect(result.strategy).toBe('inline');
  });

  it('模型支持 vision + 图片数组为空 → inline', () => {
    const result = resolveImageStrategy('glm-4v-plus', []);
    expect(result.strategy).toBe('inline');
  });

  // ---- 策略 ② strip：模型不支持 vision ----

  it('模型不支持 vision + 有图片 → strip + warning + llmHint', () => {
    const result = resolveImageStrategy('glm-5.2', [MOCK_IMAGE]);
    expect(result.strategy).toBe('strip');
    // warning 给用户看
    expect(result.warning).toContain('不支持图片输入');
    expect(result.warning).toContain('glm-5.2');
    // llmHint 给 LLM 看，包含图片数量和引导
    expect(result.llmHint).toContain('1 张图片');
    expect(result.llmHint).toContain('glm-5.2');
    expect(result.llmHint).toContain('工具列表');
    expect(result.llmHint).toContain('analyze_image');
  });

  it('多张图片 → llmHint 包含正确数量', () => {
    const result = resolveImageStrategy('glm-5.2', [MOCK_IMAGE, MOCK_IMAGE]);
    expect(result.llmHint).toContain('2 张图片');
  });

  // ---- 无图片场景 ----

  it('无图片 + 模型不支持 vision → inline（无降级）', () => {
    const result = resolveImageStrategy('glm-5.2', undefined);
    expect(result.strategy).toBe('inline');
    expect(result.warning).toBeUndefined();
    expect(result.llmHint).toBeUndefined();
  });

  // ---- 纯函数 ----

  it('相同输入产生相同输出', () => {
    const r1 = resolveImageStrategy('glm-5.2', [MOCK_IMAGE]);
    const r2 = resolveImageStrategy('glm-5.2', [MOCK_IMAGE]);
    expect(r1).toEqual(r2);
    expect(r1.strategy).toBe('strip');
  });
});
