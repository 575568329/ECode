import { describe, it, expect } from 'vitest';
// buildSkillCaptureConfig：从已加载 config 解析出强类型 SkillCaptureConfig（纯函数，避单例困境）。
// 对齐 router/config.ts 的分层：providers 宽松持有 → 本模块纯函数强类型解析。
import { buildSkillCaptureConfig, DEFAULT_SKILL_CAPTURE_CONFIG } from '../src/skill-capture/config.js';
import type { ECodeConfig } from '../src/providers/config.js';

function baseConfig(overrides: Record<string, unknown> = {}): ECodeConfig {
  return { providers: {}, models: {}, ...overrides } as ECodeConfig;
}

describe('buildSkillCaptureConfig', () => {
  it('config 无 skillCapture 块时返回默认（enabled=false，记录默认关）', () => {
    const sc = buildSkillCaptureConfig(baseConfig());
    expect(sc.enabled).toBe(false);
    expect(sc.patterns).toEqual([]);
    expect(sc.maxBytes).toBe(DEFAULT_SKILL_CAPTURE_CONFIG.maxBytes);
    expect(sc.maxObservations).toBe(DEFAULT_SKILL_CAPTURE_CONFIG.maxObservations);
  });

  it('用户配置覆盖默认（enabled=true + 自定义 patterns 生效，其余字段保持默认）', () => {
    const cfg = baseConfig({ skillCapture: { enabled: true, patterns: ['下次', 'prefer'] } });
    const sc = buildSkillCaptureConfig(cfg);
    expect(sc.enabled).toBe(true);
    expect(sc.patterns).toEqual(['下次', 'prefer']);
    expect(sc.maxBytes).toBe(DEFAULT_SKILL_CAPTURE_CONFIG.maxBytes);
  });

  it('enabled 缺省时默认 false（即使用户配了其他字段，记录仍关）', () => {
    const cfg = baseConfig({ skillCapture: { patterns: ['x'] } });
    expect(buildSkillCaptureConfig(cfg).enabled).toBe(false);
  });

  it('用户自定义上限覆盖默认 maxBytes/maxObservations', () => {
    const cfg = baseConfig({ skillCapture: { enabled: true, maxBytes: 512000, maxObservations: 500 } });
    const sc = buildSkillCaptureConfig(cfg);
    expect(sc.maxBytes).toBe(512000);
    expect(sc.maxObservations).toBe(500);
  });

  it('patterns 非数组时回退为空数组（防御脏配置）', () => {
    const cfg = baseConfig({ skillCapture: { patterns: '不是数组' } });
    expect(buildSkillCaptureConfig(cfg).patterns).toEqual([]);
  });
});
