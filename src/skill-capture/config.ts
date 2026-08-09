// ============================================================
// 技能捕获配置读取（M6 阶段D 技能生成）—— config.json skillCapture 块 → SkillCaptureConfig
// ============================================================
//
// 职责边界（对齐 router/config.ts 分层）：
//   - providers/config.ts：宽松持有 skillCapture（Record<string, unknown>），不 import 本模块类型。
//   - 本文件：buildSkillCaptureConfig 纯函数（注入已加载 config，强类型解析 + 默认值合并），
//             避单例缓存（cachedConfig）的测试困境；getSkillCaptureConfig 薄生产入口。
//
// 默认 enabled=false（记录默认关，config 开启才记；用户决策 §0）。
import { loadConfig } from '../providers/config.js';
import type { ECodeConfig } from '../providers/config.js';

/** 技能捕获配置（recorder.recordObservation 等消费）。 */
export interface SkillCaptureConfig {
  /** 是否记录用户修正/偏好到 observations.jsonl。默认 false（隐私 + 噪音控制）。 */
  enabled: boolean;
  /** 用户自定义正则（与内置 correction/preference 合并命中即记）。 */
  patterns: string[];
  /** observations.jsonl 磁盘上限（字节）。超限 FIFO 删最老。 */
  maxBytes: number;
  /** observations.jsonl 条数上限。超限 FIFO 删最老。 */
  maxObservations: number;
}

/** 默认配置（1MB / 1000 条，对齐详设 §3 容量控制）。 */
export const DEFAULT_SKILL_CAPTURE_CONFIG: SkillCaptureConfig = {
  enabled: false,
  patterns: [],
  maxBytes: 1_048_576,
  maxObservations: 1000,
};

/**
 * 从已加载 config 解析出 SkillCaptureConfig（纯函数，测试注入 config 避单例困境）。
 * 用户配置与默认合并：字段缺失取默认；patterns 非数组回退空数组（防御脏配置）。
 */
export function buildSkillCaptureConfig(cfg: ECodeConfig): SkillCaptureConfig {
  const raw = cfg.skillCapture as Partial<SkillCaptureConfig> | undefined;
  if (!raw) return { ...DEFAULT_SKILL_CAPTURE_CONFIG };
  return {
    enabled: raw.enabled ?? DEFAULT_SKILL_CAPTURE_CONFIG.enabled,
    patterns: Array.isArray(raw.patterns) ? raw.patterns : [],
    maxBytes: raw.maxBytes ?? DEFAULT_SKILL_CAPTURE_CONFIG.maxBytes,
    maxObservations: raw.maxObservations ?? DEFAULT_SKILL_CAPTURE_CONFIG.maxObservations,
  };
}

/** 生产入口：读单例 config → SkillCaptureConfig（recorder 等消费）。 */
export function getSkillCaptureConfig(): SkillCaptureConfig {
  return buildSkillCaptureConfig(loadConfig());
}
