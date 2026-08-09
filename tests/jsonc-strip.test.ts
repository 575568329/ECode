import { describe, it, expect } from 'vitest';
// stripJsonComments：JSONC 注释剥离纯函数（零依赖状态机），供 loadConfig 用。
// 标准 JSON 是合法 JSONC，故现有 config.json 零迁移；本测覆盖各类注释 + 字符串内边界。
import { stripJsonComments } from '../src/providers/config.js';

describe('stripJsonComments', () => {
  it('无注释的标准 JSON 原样可解析（零迁移前提）', () => {
    const json = '{"a": 1, "b": [2, 3]}';
    expect(JSON.parse(stripJsonComments(json))).toEqual({ a: 1, b: [2, 3] });
  });

  it('剥除行首 // 整行注释', () => {
    const jsonc = '// 这是注释\n{"a": 1}\n// 尾部注释';
    expect(JSON.parse(stripJsonComments(jsonc))).toEqual({ a: 1 });
  });

  it('剥除行尾 // 注释（保留前面代码与键值）', () => {
    const jsonc = '{"a": 1, // 行尾注释\n"b": 2}';
    expect(JSON.parse(stripJsonComments(jsonc))).toEqual({ a: 1, b: 2 });
  });

  it('剥除单行 /* */ 内联块注释', () => {
    const jsonc = '{"a": /* 内联块 */ 1}';
    expect(JSON.parse(stripJsonComments(jsonc))).toEqual({ a: 1 });
  });

  it('剥除跨行 /* */ 块注释', () => {
    const jsonc = '{\n/* 多行\n   块注释 */\n"a": 1\n}';
    expect(JSON.parse(stripJsonComments(jsonc))).toEqual({ a: 1 });
  });

  it('保留字符串内的 // （如 URL，不误剥——核心边界）', () => {
    const jsonc = '{"url": "https://api.example.com"}';
    expect(JSON.parse(stripJsonComments(jsonc))).toEqual({ url: 'https://api.example.com' });
  });

  it('保留字符串内的 /* （不误剥）', () => {
    const jsonc = '{"regex": "a/*b"}';
    expect(JSON.parse(stripJsonComments(jsonc))).toEqual({ regex: 'a/*b' });
  });

  it('正确处理转义引号：字符串内的 // 不被当注释、不提前结束字符串', () => {
    // 传入 strip 的实际串：{"a": "x\"//y", "b": 2}，其中 \" 为 JSON 转义引号
    const jsonc = '{"a": "x\\"//y", "b": 2}';
    expect(JSON.parse(stripJsonComments(jsonc))).toEqual({ a: 'x"//y', b: 2 });
  });

  it('混合：header 注释 + 行尾注释 + URL + 块注释（真实 config 场景）', () => {
    const jsonc = [
      '// ECode 配置（首次生成）',
      '{',
      '  /* 路由块 */',
      '  "routing": { "default": "glm" }, // 默认路由',
      '  "url": "https://example.com"',
      '}',
    ].join('\n');
    const parsed = JSON.parse(stripJsonComments(jsonc));
    expect(parsed.routing.default).toBe('glm');
    expect(parsed.url).toBe('https://example.com');
  });
});
