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

  it('模型支持 vision + 有图片 → inline', () => {
    const result = resolveImageStrategy('glm-4v-plus', [MOCK_IMAGE]);
    expect(result.strategy).toBe('inline');
    expect(result.warning).toBeUndefined();
  });

  it('模型支持 vision + 无图片 → inline（no-op）', () => {
    const result = resolveImageStrategy('glm-4v-plus', undefined);
    expect(result.strategy).toBe('inline');
  });

  it('模型支持 vision + 图片数组为空 → inline（no-op）', () => {
    const result = resolveImageStrategy('glm-4v-plus', []);
    expect(result.strategy).toBe('inline');
  });

  // ---- 策略 ② strip：模型不支持 vision ----

  it('模型不支持 vision + 有图片 → strip + 友好提示', () => {
    const result = resolveImageStrategy('glm-5.2', [MOCK_IMAGE]);
    expect(result.strategy).toBe('strip');
    expect(result.warning).toContain('不支持图片输入');
    expect(result.warning).toContain('glm-5.2');
  });

  it('strip 提示引导用户用 MCP 工具或配置 vision 模型', () => {
    const result = resolveImageStrategy('glm-5.2', [MOCK_IMAGE]);
    expect(result.warning).toContain('MCP');
    expect(result.warning).toContain('config.json');
    expect(result.warning).toContain('vision');
  });

  // ---- 无图片场景：任何模型都走 inline ----

  it('无图片 + 模型不支持 vision → inline（无降级）', () => {
    const result = resolveImageStrategy('glm-5.2', undefined);
    expect(result.strategy).toBe('inline');
    expect(result.warning).toBeUndefined();
  });

  it('无图片 + 空图片数组 → inline', () => {
    const result = resolveImageStrategy('glm-5.2', []);
    expect(result.strategy).toBe('inline');
  });

  // ---- 防无限调用 ----

  it('决策是纯函数：相同输入产生相同输出', () => {
    const r1 = resolveImageStrategy('glm-5.2', [MOCK_IMAGE]);
    const r2 = resolveImageStrategy('glm-5.2', [MOCK_IMAGE]);
    expect(r1).toEqual(r2);
    expect(r1.strategy).toBe('strip');
  });
});
