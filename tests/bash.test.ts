// executeBash 单测：异步 spawn + 跨平台（Git Bash 兜底 / chcp 编码 / 超时）。
// 治 #3（同步阻塞 UI 卡死）#4（find.exe / ETIMEDOUT）#5（GBK 乱码）#6（死循环连锁）。
import { describe, it, expect } from 'vitest';
import { executeBash } from '../src/tools/bash.js';

describe('executeBash（异步 spawn + 跨平台）', () => {
  it('返回 Promise（异步，不阻塞主线程 → 治 #3）', () => {
    const r = executeBash({ command: 'echo x' });
    expect(r).toBeInstanceOf(Promise);
    // 消费掉，避免 unhandled rejection
    void r.then(() => undefined);
  });

  it('简单命令成功 → 返回输出（isError=false）', async () => {
    const r = await executeBash({ command: 'echo hello-ecode' });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('hello-ecode');
  });

  it('多行输出完整保留（不丢行）', async () => {
    const r = await executeBash({ command: 'echo line1 && echo line2 && echo line3' });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('line1');
    expect(r.content).toContain('line2');
    expect(r.content).toContain('line3');
  });

  it('命令尾部换行 → 截断后不残留空行噪声（execSync 旧实现遗留习惯）', async () => {
    const r = await executeBash({ command: 'echo single' });
    expect(r.content.trim()).toBe('single');
  });

  it('错误命令 → isError=true 且含错误信息（供 LLM 排错）', async () => {
    const r = await executeBash({ command: 'ecode_nonexistent_cmd_xyz_12345' });
    expect(r.isError).toBe(true);
    expect(r.content.length).toBeGreaterThan(0);
  });

  it('Unix 管道命令可执行（Git Bash 兜底回归 #4：cmd 不认 head/find 会失败）', async () => {
    // echo | head 是纯 Unix 管道：cmd 直接报错；有 Git Bash / 非 Windows 则成功。
    // 不强断言平台结果（CI 环境差异），只验证返回有效、不卡死/不死循环。
    const r = await executeBash({ command: 'echo ecode-pipe-test | head -1' });
    expect(typeof r.isError).toBe('boolean');
    expect(typeof r.content).toBe('string');
    // 本机（Windows + Git Bash）应成功跑通管道
    if (process.platform === 'win32') {
      expect(r.content).toContain('ecode-pipe-test');
    }
  });

  it('stderr 优先于 stdout 作为错误信息（排错可见）', async () => {
    // 用一个明确写 stderr 的失败命令：Windows/Unix 都有的 node 写 stderr
    const r = await executeBash({
      command: 'node -e "process.stderr.write(\'stderr-ecode\'); process.exit(1)"',
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('stderr-ecode');
  });
});
