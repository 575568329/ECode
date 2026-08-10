// vision-fallback.ts —— 图片输入三级降级测试
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveImageStrategy } from '../src/vision-fallback.js';

// Mock config 依赖（resolveImageStrategy 调 hasCapability + listAvailableModels）
vi.mock('../src/providers/config.js', () => ({
  hasCapability: vi.fn((model: string, cap: string) => {
    // glm-5.2 不支持 vision；glm-4v-plus 支持
    if (cap === 'vision') return model === 'glm-4v-plus';
    if (cap === 'tools') return true;
    return false;
  }),
  listAvailableModels: vi.fn(() => [
    { model: 'glm-5.2', provider: 'glm' },
    { model: 'glm-4v-plus', provider: 'glm' },
  ]),
}));

import { hasCapability, listAvailableModels } from '../src/providers/config.js';
const mockedHasCapability = vi.mocked(hasCapability);
const mockedListAvailableModels = vi.mocked(listAvailableModels);

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
    expect(result.switchToModel).toBeUndefined();
  });

  it('模型支持 vision + 无图片 → inline（no-op）', () => {
    const result = resolveImageStrategy('glm-4v-plus', undefined);
    expect(result.strategy).toBe('inline');
  });

  it('模型支持 vision + 图片数组为空 → inline（no-op）', () => {
    const result = resolveImageStrategy('glm-4v-plus', []);
    expect(result.strategy).toBe('inline');
  });

  // ---- 策略 ② switch：模型不支持 vision，config 有 vision 模型 ----

  it('模型不支持 vision + config 有 vision 模型 → switch', () => {
    const result = resolveImageStrategy('glm-5.2', [MOCK_IMAGE]);
    expect(result.strategy).toBe('switch');
    expect(result.switchToModel).toBe('glm-4v-plus');
    expect(result.warning).toContain('glm-5.2');
    expect(result.warning).toContain('glm-4v-plus');
  });

  it('模型不支持 vision + 多个 vision 模型 → switch 到第一个匹配', () => {
    mockedListAvailableModels.mockReturnValue([
      { model: 'glm-5.2', provider: 'glm' },
      { model: 'glm-4v-plus', provider: 'glm' },
      { model: 'claude-3.5-sonnet', provider: 'claude' },
    ]);
    // claude 也支持 vision（mock 中 hasCapability 只对 glm-4v-plus 返回 true）
    // 验证返回的是首个 vision 模型（glm-4v-plus）
    const result = resolveImageStrategy('glm-5.2', [MOCK_IMAGE]);
    expect(result.strategy).toBe('switch');
    expect(result.switchToModel).toBe('glm-4v-plus');
  });

  it('switch 不会切到当前模型（排除自身）', () => {
    // 即便当前模型碰巧有 vision 能力，也不应 switch 到自己（但 inline 分支已先拦截）
    // 这里测 listAvailableModels 排除逻辑
    mockedListAvailableModels.mockReturnValue([
      { model: 'glm-5.2', provider: 'glm' },
    ]);
    // glm-5.2 无 vision → 不会在 list 中找到其他 vision 模型 → strip
    const result = resolveImageStrategy('glm-5.2', [MOCK_IMAGE]);
    expect(result.strategy).toBe('strip');
  });

  // ---- 策略 ③ strip：模型不支持 vision，config 无 vision 模型 ----

  it('模型不支持 vision + config 无 vision 模型 → strip', () => {
    mockedListAvailableModels.mockReturnValue([
      { model: 'glm-5.2', provider: 'glm' },
      { model: 'deepseek-chat', provider: 'deepseek' },
    ]);
    mockedHasCapability.mockImplementation((_model: string, cap: string) => cap === 'tools');

    const result = resolveImageStrategy('glm-5.2', [MOCK_IMAGE]);
    expect(result.strategy).toBe('strip');
    expect(result.switchToModel).toBeUndefined();
    expect(result.warning).toContain('不支持图片输入');
    expect(result.warning).toContain('config.json');
    expect(result.warning).toContain('vision');
  });

  it('strip 提示引导用户配置 vision 模型或用 MCP 工具', () => {
    mockedListAvailableModels.mockReturnValue([
      { model: 'glm-5.2', provider: 'glm' },
    ]);
    mockedHasCapability.mockImplementation(() => false);

    const result = resolveImageStrategy('glm-5.2', [MOCK_IMAGE]);
    expect(result.strategy).toBe('strip');
    expect(result.warning).toContain('MCP');
  });

  // ---- 无图片场景：任何模型都走 inline（no-op）----

  it('无图片 + 模型不支持 vision → inline（无降级）', () => {
    mockedListAvailableModels.mockReturnValue([
      { model: 'glm-5.2', provider: 'glm' },
    ]);
    const result = resolveImageStrategy('glm-5.2', undefined);
    expect(result.strategy).toBe('inline');
    expect(result.warning).toBeUndefined();
  });

  it('无图片 + 空图片数组 → inline（无降级）', () => {
    const result = resolveImageStrategy('glm-5.2', []);
    expect(result.strategy).toBe('inline');
  });

  // ---- 防无限调用 ----

  it('决策是纯函数：相同输入产生相同输出（不依赖外部状态变化）', () => {
    mockedListAvailableModels.mockReturnValue([
      { model: 'glm-5.2', provider: 'glm' },
      { model: 'glm-4v-plus', provider: 'glm' },
    ]);
    mockedHasCapability.mockImplementation((model: string, cap: string) =>
      cap === 'vision' && model === 'glm-4v-plus');

    const r1 = resolveImageStrategy('glm-5.2', [MOCK_IMAGE]);
    const r2 = resolveImageStrategy('glm-5.2', [MOCK_IMAGE]);
    expect(r1).toEqual(r2);
    expect(r1.strategy).toBe('switch');
  });

  it('getModelConfig 抛错的模型被跳过（不崩）', () => {
    // listAvailableModels 返回一个会触发 hasCapability 抛错的模型
    mockedListAvailableModels.mockReturnValue([
      { model: 'broken-model', provider: 'x' },
      { model: 'glm-4v-plus', provider: 'glm' },
    ]);
    // hasCapability 对 broken-model 抛错，对 glm-4v-plus 返回 true
    mockedHasCapability.mockImplementation((model: string, cap: string) => {
      if (model === 'broken-model') throw new Error('模型配置不完整');
      return cap === 'vision' && model === 'glm-4v-plus';
    });

    const result = resolveImageStrategy('glm-5.2', [MOCK_IMAGE]);
    // broken-model 被跳过，glm-4v-plus 被选中
    expect(result.strategy).toBe('switch');
    expect(result.switchToModel).toBe('glm-4v-plus');
  });
});
