import { describe, it, expect } from 'vitest';
// assessComplexity：启发式复杂度评估纯函数（§10）。零 LLM 成本、中英双语关键词。
import { assessComplexity } from '../src/router/complexity.js';

describe('assessComplexity', () => {
  it('中文简单任务（错别字/重命名/grep）→ simple', () => {
    expect(assessComplexity('修复错别字')).toBe('simple');
    expect(assessComplexity('重命名这个变量')).toBe('simple');
    expect(assessComplexity('grep 查找所有用到的地方')).toBe('simple');
  });

  it('中文复杂任务（重构/实现/迁移）→ complex（关键词优先于长度，短描述也能 complex）', () => {
    expect(assessComplexity('重构整个认证模块')).toBe('complex');
    expect(assessComplexity('实现新的支付功能')).toBe('complex');
    expect(assessComplexity('迁移到新框架')).toBe('complex');
  });

  it('英文简单（fix typo）→ simple', () => {
    expect(assessComplexity('fix a typo in readme')).toBe('simple');
  });

  it('英文复杂（refactor）→ complex', () => {
    expect(assessComplexity('refactor the parser module')).toBe('complex');
  });

  it('改动范围信号（多文件）→ complex', () => {
    expect(assessComplexity('批量修改多文件的导入')).toBe('complex');
  });

  it('均势（simple 词 + complex 词 + 中等长度）→ medium', () => {
    expect(assessComplexity('rename the architecture')).toBe('medium');
  });

  it('toolCount 高（≥5）在均势场景翻向 complex', () => {
    expect(assessComplexity('rename the architecture', { toolCount: 6 })).toBe('complex');
  });

  it('长描述（>100 字符）倾向 complex', () => {
    const long = '请帮我' + '详细分析'.repeat(30) + '并给出方案';
    expect(assessComplexity(long)).toBe('complex');
  });

  it('无明显信号 → medium', () => {
    expect(assessComplexity('处理这个问题')).toBe('medium');
  });
});
