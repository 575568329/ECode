import { describe, it, expect } from 'vitest';
// redactSecrets：自由文本脱敏纯函数（§9.2 红线 + §17🔴2，不复用单值掩码 maskSecret）。
// 覆盖常见密钥形态：sk- token / Bearer / token=|api_key= 赋值 / AWS AKIA。
import { redactSecrets } from '../src/skill-capture/redact.js';

describe('redactSecrets', () => {
  it('脱敏 sk- 开头的 API token（Anthropic/OpenAI 风格）', () => {
    expect(redactSecrets('my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe(
      'my key is [REDACTED]',
    );
  });

  it('脱敏 Bearer token', () => {
    expect(redactSecrets('Authorization: Bearer abc123.def456')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });

  it('脱敏 token=xxx 赋值形式', () => {
    expect(redactSecrets('config token=secret_value_here')).toBe('config token=[REDACTED]');
  });

  it('脱敏 api_key=xxx（保留下划线 key 名）', () => {
    expect(redactSecrets('api_key=sk_live_xxxxxxxx')).toBe('api_key=[REDACTED]');
  });

  it('脱敏 apikey=xxx（无下划线变体）', () => {
    expect(redactSecrets('apikey=MYKEY123')).toBe('apikey=[REDACTED]');
  });

  it('脱敏 AWS AKIA access key', () => {
    expect(redactSecrets('aws key AKIAIOSFODNN7EXAMPLE leaked')).toBe('aws key [REDACTED] leaked');
  });

  it('脱敏 token: "xxx" 引号赋值形式', () => {
    expect(redactSecrets('token: "secret123"')).toBe('token=[REDACTED]');
  });

  it('无密钥时原样返回', () => {
    expect(redactSecrets('下次提交前先跑 npm test')).toBe('下次提交前先跑 npm test');
  });

  it('混合：一句话含多种密钥全脱敏', () => {
    const out = redactSecrets('用 sk-ant-xxxxxxxxxx 或 Bearer yyy 或 api_key=zzz');
    expect(out).not.toContain('sk-ant');
    expect(out).not.toContain('yyy');
    expect(out).not.toContain('zzz');
    expect(out).toContain('[REDACTED]');
  });

  it('中文文本含密钥：密钥脱敏、中文保留', () => {
    expect(redactSecrets('密钥是 token=abc123 不要泄露')).toBe('密钥是 token=[REDACTED] 不要泄露');
  });

  it('短 sk- 串不误报（阈值≥10 字符，防 sk-ip / task- 类误伤）', () => {
    expect(redactSecrets('sk-abc')).toBe('sk-abc');
  });
});
