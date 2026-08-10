// REPL 人肉驱动测试：用 simulate() 驱动真实 <App>，按「实际渲染反馈」断言。
// 覆盖：全部斜杠命令的内容正确性 + 快捷键（↑/↓/backspace/Esc/Ctrl+C）。
//
// 为什么 mock runAgentStream 空转、却说反馈「真实」：
//   斜杠命令（/help /cost /sessions /clear /exit…）和快捷键全在 REPL/UI 层，根本不调 LLM。
//   被 mock 的只有「LLM 大脑」；reducer / useAgentStream / 组件渲染全是真的——每一帧都是真实输出。
//   唯一需要 agent 事件的 Esc/Ctrl+C 中断测试，用「yield start 后挂起等 abort」的 mock 造 running 态。
//
// ── 编写/审阅本文件测试时的 checklist（防假绿，见 docs/memory/preferences.md）──────────
//   □ 该功能的「首条 / 零状态」用例有没有？（别只测中途——/help 假绿就是只测了中途）
//   □ setup（enterConversation 等）是否偷换了被测前提？测试名是否诚实反映前置？
//   □ 写完后能否破坏对应代码让它变红？（怎么改都绿 = 假绿，去补零状态用例）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { App } from '../../src/ui/app.js';
import { runAgentStream } from '../../src/agent.js';
import { listSessions, loadSession } from '../../src/session.js';
import type { ECodeSessionSummary } from '../../src/session.js';
import { simulate } from './simulate.js';
import { runLess } from '../../src/ui/pager.js';

vi.mock('../../src/agent.js', () => ({
  runAgentStream: vi.fn(async function* (): AsyncGenerator<never> {
    // 默认空转；个别用例在 beforeEach / 用例内 mockImplementation 覆盖
  }),
  // controller 构造期访问 compactMessages（render 时），mock 必须导出它
  compactMessages: vi.fn(),
}));
// App 用 listSessions（/resume /sessions）+ loadSession（/resume 载入历史）。
// agent.ts 虽 import saveSession 但 agent.js 已被整替，不执行 → 此处给 listSessions/loadSession。
vi.mock('../../src/session.js', () => ({
  listSessions: vi.fn(() => [] as ECodeSessionSummary[]),
  loadSession: vi.fn(),
}));
// Ctrl+O 转录 pager（方向 B）：app 调 runLess spawn less；测试 mock 掉避免真起进程，
// 用 mockResolvedValue/mockRejectedValue 模拟 less 正常退出 / 失败。
vi.mock('../../src/ui/pager.js', () => ({
  runLess: vi.fn(),
}));
// MCP 连接隔离：repl-human 测斜杠命令/快捷键，不依赖真 MCP server（避免连 ~/.ecode 全局 registry 拖慢/不稳）。
// loadMcpRegistry 返回空 → connectAll no-op → pool 空 → shutdown fast-path 同步 exit
//（双击 Ctrl+C / /exit 的 process.exit 同步断言不破坏，debugging #019）。
// importOriginal 保留 maskSecret 等（App 渲染依赖），只覆盖 loadMcpRegistry。
vi.mock('../../src/mcp/registry.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadMcpRegistry: () => [] };
});

const mockedRun = runAgentStream as unknown as ReturnType<typeof vi.fn>;
const mockedList = listSessions as unknown as ReturnType<typeof vi.fn>;
const mockedLoad = loadSession as unknown as ReturnType<typeof vi.fn>;
const mockedRunLess = runLess as unknown as ReturnType<typeof vi.fn>;

const CWD = '/tmp/ecode-human-test';

/**
 * 先发一条真消息把 <App> 从欢迎屏推进 ChatView（started=true）。
 * 必要性：handleSubmit 对斜杠命令在 setStarted(true) 之前 return —— 命令作为首条输入时
 * 卡在欢迎屏，命令输出（addMessage 进 completedMessages）要等 ChatView 挂载后才随 <Static> 渲染。
 * 这也是真实使用场景（命令一般在中途用），非取巧。
 */
async function enterConversation(sim: Awaited<ReturnType<typeof simulate>>): Promise<void> {
  await sim.type('开始对话');
  await sim.enter();
  await sim.waitFor((f) => f.includes('开始对话'));
}

/** 造一个「已启动并挂起」的 agent：yield start + text_delta 置 isRunning=true（LLM 已回应=情况 B），
 *  随后等 abort 信号才 yield completed(aborted)——对齐真实 agent（abort→completed，非 throw）。 */
function hangingRun(): void {
  mockedRun.mockImplementation(async function* (text: string, opts: { signal: AbortSignal }) {
    yield { type: 'start', task: text, model: 'glm-5.2', provider: 'glm' };
    yield { type: 'text_delta', text: '部分' }; // 模拟 LLM 已回应 → 中断走情况 B（显示已中断）
    await new Promise<void>((resolve) => {
      opts.signal.addEventListener('abort', () => resolve());
    });
    yield {
      type: 'completed',
      rounds: 1,
      toolCalls: 0,
      reason: 'aborted',
      sessionId: 's',
      task: text,
      createdAt: 't',
      messages: [
        { role: 'user', content: text },
        { role: 'assistant', content: [{ type: 'text', text: '部分' }] },
      ],
    };
  });
}

describe('REPL 人肉驱动 —— 斜杠命令（按实际反馈）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedRun.mockImplementation(async function* () {});
    mockedList.mockReturnValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('/help 输出全部命令 + 描述', async () => {
    const sim = simulate(<App cwd={CWD} />);
    await enterConversation(sim);
    await sim.type('/help');
    await sim.enter();
    await sim.waitFor((f) => f.includes('可用命令'));
    const f = sim.plain();
    expect(f).toMatch(/\/help.*显示可用命令/);
    expect(f).toMatch(/\/cost.*token/i);
    expect(f).toMatch(/\/sessions.*会话/);
    expect(f).toMatch(/\/clear.*清空/);
  });

  it('/help 作为首条输入（未先进对话）也能显示输出', async () => {
    // 真实场景：用户一启动就敲 /help。命令分支此前在 setStarted(true) 之前 return，
    // 欢迎屏期间 ChatView 未挂载 → addMessage 的「可用命令」无处渲染 → 用户看到「没效果」。
    // 本用例不先 enterConversation，直接首条命令，复现并守住这条路径。
    const sim = simulate(<App cwd={CWD} />);
    await sim.type('/help');
    await sim.enter();
    await sim.waitFor((f) => f.includes('可用命令'));
    expect(sim.plain()).toMatch(/\/help.*显示可用命令/);
  });

  it('/cost 显示 token 用量（空转 agent → 全 0）', async () => {
    const sim = simulate(<App cwd={CWD} />);
    await enterConversation(sim);
    await sim.type('/cost');
    await sim.enter();
    await sim.waitFor((f) => f.includes('Token 用量'));
    expect(sim.plain()).toContain('输入 0 · 输出 0 · 总计 0');
  });

  it('/sessions 无会话 → 提示暂无', async () => {
    mockedList.mockReturnValue([]);
    const sim = simulate(<App cwd={CWD} />);
    await enterConversation(sim);
    await sim.type('/sessions');
    await sim.enter();
    await sim.waitFor((f) => f.includes('暂无历史会话'));
  });

  it('/sessions 单条会话 → 列出并计数 1（含短 id）', async () => {
    mockedList.mockReturnValue([
      {
        id: 'abcdef1234567890',
        task: '写快排',
        model: 'glm-5.2',
        createdAt: '',
        updatedAt: '',
        stats: { rounds: 3, compressed: false, toolCalls: 2 },
      },
    ]);
    const sim = simulate(<App cwd={CWD} />);
    await enterConversation(sim);
    await sim.type('/sessions');
    await sim.enter();
    await sim.waitFor((f) => f.includes('历史会话'));
    const f = sim.plain();
    expect(f).toContain('写快排');
    expect(f).toContain('(glm-5.2, 3轮)');
    expect(f).toContain('共 1 个会话');
    expect(f).toContain('abcdef12'); // 短 id（UUID 前 8 位）
  });

  it('/sessions 超 10 条 → 截断前 10 + 总数 footer', async () => {
    const many: ECodeSessionSummary[] = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      task: `任务${i}`,
      model: 'glm-5.2',
      createdAt: '',
      updatedAt: '',
      stats: { rounds: 1, compressed: false, toolCalls: 0 },
    }));
    mockedList.mockReturnValue(many);
    const sim = simulate(<App cwd={CWD} />);
    await enterConversation(sim);
    await sim.type('/sessions');
    await sim.enter();
    await sim.waitFor((f) => f.includes('历史会话'));
    const f = sim.plain();
    expect(f).toContain('任务0'); // 首条在
    expect(f).not.toContain('任务11'); // 第 12 条被截断
    expect(f).toContain('共 12 个会话(显示前 10)');
  });

  it('/clear 被识别分发，清空后仍能正常收新消息', async () => {
    // 注意：<Static> 是 append-only（写入 stdout 后不再 diff，chat-view.tsx:82 注释明说）。
    // 所以 /clear 清空 completedMessages 后「旧消息从帧消失」在 ink-testing-library 里观测不到
    // （现有 app.test.tsx 的 /clear 也只用 toBeDefined() 回避同一问题）。
    // 这里测可观测的部分：命令被识别分发（无崩溃）+ 清空后流健康（新消息能落地）。
    const sim = simulate(<App cwd={CWD} />);
    await sim.type('待清除');
    await sim.enter();
    await sim.waitFor((f) => f.includes('待清除'));
    await sim.type('/clear');
    await sim.enter();
    await sim.type('清除后新消息');
    await sim.enter();
    await sim.waitFor((f) => f.includes('清除后新消息'));
  });

  // /model（D1）与 /compact（D2）均已实现，不再提示「尚未实现」——原断言已过时，移除。

  it('/exit → process.exit', async () => {
    // ink useInput 异步节流：process.exit 在 flush 后触发。spy 空实现 + 断言被调，
    // 避免 throw mock 在异步回调成 unhandled error。
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      /* 空实现：阻止真退出，仅观测被调 */
    }) as never);
    try {
      const sim = simulate(<App cwd={CWD} />);
      await sim.type('/exit');
      await sim.enter(); // flush useInput → handleCommand('exit') → process.exit(0)
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('未知命令 /foobar → 静默忽略（无落地、无崩溃）', async () => {
    const sim = simulate(<App cwd={CWD} />);
    await sim.type('/foobar');
    await sim.enter();
    await sim.waitFor(() => true);
    // 未送 LLM、未落地消息：帧里看不到 /foobar（InputBar 提交后已清空）
    expect(sim.plain()).not.toContain('/foobar');
  });
});

describe('REPL 人肉驱动 —— 快捷键（按实际反馈）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedRun.mockImplementation(async function* () {});
    mockedList.mockReturnValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('backspace 删除末字符', async () => {
    const sim = simulate(<App cwd={CWD} />);
    await sim.type('abc');
    await sim.backspace();
    const f = sim.plain();
    expect(f).toContain('ab');
    expect(f).not.toMatch(/abc/);
  });

  it('↑ 用历史替换当前草稿（草稿消失证明 ↑ 生效）', async () => {
    const sim = simulate(<App cwd={CWD} />);
    await sim.type('已提交');
    await sim.enter();
    await sim.waitFor((f) => f.includes('已提交'));
    await sim.type('草稿未提交'); // 仅在输入栏，未提交
    await sim.up(); // ↑ 调出历史 → 输入栏切到「已提交」，草稿隐藏
    await sim.waitFor((f) => !f.includes('草稿未提交'));
  });

  it('↓ 回到草稿（草稿重新出现）', async () => {
    const sim = simulate(<App cwd={CWD} />);
    await sim.type('已提交');
    await sim.enter();
    await sim.waitFor((f) => f.includes('已提交'));
    await sim.type('草稿'); // 草稿
    await sim.up(); // → 显示历史，草稿隐藏
    await sim.waitFor((f) => !f.includes('草稿'));
    await sim.down(); // → 回到草稿
    await sim.waitFor((f) => f.includes('草稿'));
  });

  it('Ctrl+C 中断运行中流（isRunning→false，输入栏恢复）', async () => {
    // 键位分工（详设 docs/详设/20260807000318，2026-08-07 反转）：Ctrl+C 专职中断（单击）+ 关闭对话（双击）。
    hangingRun();
    const sim = simulate(<App cwd={CWD} />);
    await sim.type('跑起来');
    await sim.enter();
    await sim.waitFor((f) => f.includes('interrupt')); // isRunning=true → InputBar 显 disabled
    await sim.ctrlC();
    await sim.waitFor((f) => !f.includes('interrupt')); // abort → 恢复输入栏
    await sim.waitFor((f) => f.includes('— 已中断 —')); // §3.5：中断 warning（纯 UI 反馈）
  });

  it('Esc 不中断流（中断专职 Ctrl+C）—— streaming 时 Esc 无效', async () => {
    // Esc 只做「退出对话框（modal）+ 双击清空输入框」，不中断；中断归 Ctrl+C。
    hangingRun();
    const sim = simulate(<App cwd={CWD} />);
    await sim.type('跑起来');
    await sim.enter();
    await sim.waitFor((f) => f.includes('interrupt')); // running
    await sim.esc(); // Esc 不再中断
    await sim.waitFor((f) => f.includes('interrupt')); // 仍 running（Esc 无效，未 abort）
    sim.unmount(); // 挂起 mock 不中断则手动卸载避免泄漏
  });

  it('Ctrl+C 双击 → process.exit（关闭对话）', async () => {
    // shutdown 是 async（清理 MCP），process.exit 在其体内执行；用空实现 spy + 断言被调，
    // 避免 throw mock 在 async 函数成 unhandled rejection（rejects.toThrow 抓不到 fire-and-forget）。
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      /* 空实现：阻止真退出，仅观测被调 */
    }) as never);
    const sim = simulate(<App cwd={CWD} />);
    await sim.ctrlC(); // 单击：进退出窗口
    await sim.ctrlC(); // 双击 → void shutdown(0) → process.exit(0)
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('双击 Esc 清空输入框（idle，有内容→清空）', async () => {
    const sim = simulate(<App cwd={CWD} />);
    await enterConversation(sim);
    await sim.type('一些草稿');
    await sim.waitFor((f) => f.includes('一些草稿'));
    await sim.esc();
    await sim.esc(); // 双击 → 清空
    await sim.waitFor((f) => !f.includes('一些草稿'));
  });

  it('picker 打开时 Esc 关 picker（不退出不清空，输入保留）', async () => {
    const sim = simulate(<App cwd={CWD} />);
    await enterConversation(sim);
    await sim.type('/'); // 触发斜杠 picker
    await sim.waitFor((f) => f.includes('esc 取消')); // picker 出现（hint 含「esc 取消」）
    await sim.esc(); // 单击 Esc 关 picker
    await sim.waitFor((f) => !f.includes('esc 取消')); // picker 消失
    expect(sim.plain()).toContain('/'); // 输入框保留 '/'（Esc 关 picker 不清空）
  });
});

describe('REPL 人肉驱动 —— 斜杠补全 picker（方向 A）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedRun.mockImplementation(async function* () {});
    mockedList.mockReturnValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // 判断 picker 候选用 SLASH_COMMANDS 的描述词（如「显示可用命令」「清空对话历史」），
  // 不用 /help 等——欢迎屏自带命令列表也含 /help，会误判。
  // （防假绿：断言要命中 picker 独有物。）
  // 零状态用例（防假绿第 2 条）：首条即 /，纯 InputBar 行为，不 enterConversation。

  it('输 / 显示命令候选（首条零状态）', async () => {
    const sim = simulate(<App cwd={CWD} />);
    await sim.type('/');
    await sim.waitFor((f) => f.includes('显示可用命令')); // help 候选
    const f = sim.plain();
    expect(f).toContain('显示可用命令'); // help
    expect(f).toContain('清空对话历史'); // clear
    expect(f).toContain('显示当前会话 token 用量'); // cost
  });

  it('前缀过滤 /c → 只剩 clear/cost/compact', async () => {
    const sim = simulate(<App cwd={CWD} />);
    await sim.type('/c');
    await sim.waitFor((f) => f.includes('清空对话历史'));
    const f = sim.plain();
    expect(f).toContain('清空对话历史'); // clear
    expect(f).toContain('显示当前会话 token 用量'); // cost
    expect(f).toContain('手动触发上下文压缩'); // compact
    expect(f).not.toContain('显示可用命令'); // help 被 /c 过滤掉
  });

  it('无匹配 /foo → 不显示候选', async () => {
    const sim = simulate(<App cwd={CWD} />);
    await sim.type('/foo');
    await sim.waitFor(() => true);
    expect(sim.plain()).not.toContain('显示可用命令');
    expect(sim.plain()).not.toContain('清空对话历史');
  });

  it('带参 /clear（空格）→ 不显示候选', async () => {
    const sim = simulate(<App cwd={CWD} />);
    await sim.type('/clear ');
    await sim.waitFor(() => true);
    // 带空格后 picker 消失：clear 候选描述「清空对话历史」不在（输入行 /clear 本身不含它）
    expect(sim.plain()).not.toContain('清空对话历史');
  });

  it('默认选中第一项，↓ 移到第二项（选中指示 ❯）', async () => {
    const sim = simulate(<App cwd={CWD} />);
    await sim.type('/c'); // 候选 [clear, cost, compact]
    await sim.waitFor((f) => f.includes('清空对话历史'));
    expect(sim.plain()).toMatch(/❯\s*\/clear/); // 默认选中 clear
    await sim.down();
    await sim.waitFor(() => true);
    expect(sim.plain()).toMatch(/❯\s*\/cost/); // ↓ 后选中 cost
    expect(sim.plain()).not.toMatch(/❯\s*\/clear/);
  });

  it('Enter 直接执行选中命令（/c → ↓ cost → enter → Token 用量）', async () => {
    const sim = simulate(<App cwd={CWD} />);
    await enterConversation(sim);
    await sim.type('/c');
    await sim.waitFor((f) => f.includes('清空对话历史'));
    await sim.down(); // 选中 cost
    await sim.enter(); // 直接执行（不先 Tab）
    await sim.waitFor((f) => f.includes('Token 用量'));
    expect(sim.plain()).toContain('输入 0 · 输出 0 · 总计 0');
  });

  it('Esc 关闭 picker 不执行（text 保留、无命令输出）', async () => {
    const sim = simulate(<App cwd={CWD} />);
    await sim.type('/c');
    await sim.waitFor((f) => f.includes('清空对话历史'));
    await sim.esc();
    await sim.waitFor((f) => !f.includes('清空对话历史')); // 候选消失
    const f = sim.plain();
    expect(f).toContain('/c'); // text 保留
    expect(f).not.toContain('Token 用量'); // 未执行命令
    expect(f).not.toContain('可用命令');
  });

  it('非 / 输入不显示候选', async () => {
    const sim = simulate(<App cwd={CWD} />);
    await sim.type('hello');
    await sim.waitFor(() => true);
    const f = sim.plain();
    expect(f).toContain('hello');
    expect(f).not.toContain('显示可用命令');
  });

  it('选中后真执行（/help → enter → 可用命令，防假绿第 3 条）', async () => {
    const sim = simulate(<App cwd={CWD} />);
    await enterConversation(sim);
    await sim.type('/help'); // 唯一匹配，选中
    await sim.waitFor((f) => f.includes('显示可用命令')); // picker help 候选
    await sim.enter();
    await sim.waitFor((f) => f.includes('可用命令')); // 命令真执行
    expect(sim.plain()).toMatch(/\/help.*显示可用命令/);
  });
});

describe('REPL 人肉驱动 —— /resume 会话切换（方向 C）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedRun.mockImplementation(async function* () {});
    mockedList.mockReturnValue([]);
    mockedLoad.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // 辅助：让 agent yield completed 设 sessionRef.id（测「过滤当前会话」需当前会话有 id）。
  function runThatCompletes(sessionId: string): void {
    mockedRun.mockImplementation(async function* (text: string) {
      yield { type: 'start', task: text, model: 'glm-5.2', provider: 'glm' };
      yield {
        type: 'completed',
        sessionId,
        task: text,
        createdAt: '',
        messages: [{ role: 'user', content: text }],
        rounds: 1,
        reason: 'done',
      };
    });
  }

  // 等 InputBar 从 running 恢复（completed 后 isRunning=false，「interrupt」消失）。
  async function waitForIdle(sim: Awaited<ReturnType<typeof simulate>>): Promise<void> {
    await sim.waitFor((f) => !f.includes('interrupt'));
  }

  it('/resume 无会话 → 提示暂无（不弹 picker）', async () => {
    mockedList.mockReturnValue([]);
    const sim = simulate(<App cwd={CWD} />);
    await enterConversation(sim);
    await sim.type('/resume');
    await sim.enter();
    await sim.waitFor((f) => f.includes('暂无历史会话'));
    expect(sim.plain()).not.toContain('恢复会话'); // 未弹 picker
  });

  it('/resume 过滤当前会话（列表不含当前会话任务，防假绿：真过滤非全显）', async () => {
    runThatCompletes('current-id');
    mockedList.mockReturnValue([
      { id: 'current-id', task: '当前会话任务', model: 'glm-5.2', createdAt: '', updatedAt: '', stats: { rounds: 1, compressed: false, toolCalls: 0 } },
      { id: 'other-id', task: '历史会话任务', model: 'glm-5.2', createdAt: '', updatedAt: '', stats: { rounds: 2, compressed: false, toolCalls: 0 } },
    ]);
    const sim = simulate(<App cwd={CWD} />);
    await sim.type('任意');
    await sim.enter();
    await waitForIdle(sim); // 等 completed 设 sessionRef.id = current-id
    await sim.type('/resume');
    await sim.enter();
    await sim.waitFor((f) => f.includes('恢复会话'));
    const f = sim.plain();
    expect(f).toContain('历史会话任务'); // other 在列表
    expect(f).not.toContain('当前会话任务'); // current 被过滤
  });

  it('/resume 弹选择器 → 显示 task + metadata（模型·轮数·相对时间·短id）', async () => {
    mockedList.mockReturnValue([
      { id: 'abcdef1234567890', task: '写快排', model: 'glm-5.2', createdAt: '', updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(), stats: { rounds: 3, compressed: false, toolCalls: 1 } },
    ]);
    const sim = simulate(<App cwd={CWD} />);
    await enterConversation(sim);
    await sim.type('/resume');
    await sim.enter();
    await sim.waitFor((f) => f.includes('恢复会话'));
    const f = sim.plain();
    expect(f).toContain('写快排');
    expect(f).toContain('glm-5.2');
    expect(f).toContain('3轮');
    expect(f).toMatch(/分钟前|刚刚/); // 相对时间
    // 短 id（UUID 前 8 位）放 metadata 行尾：区分同名会话 + 便于 --resume <id> 定位文件。
    // 防假绿：前 8 在、尾部不在 → 证明是 slice 截断而非全显。
    expect(f).toContain('abcdef12');
    expect(f).not.toContain('34567890');
  });

  it('↑↓ 循环导航（首项 ↑ 跳末项，对齐 CC use-select-navigation）', async () => {
    mockedList.mockReturnValue([
      { id: 's1', task: '任务一', model: 'glm-5.2', createdAt: '', updatedAt: '', stats: { rounds: 1, compressed: false, toolCalls: 0 } },
      { id: 's2', task: '任务二', model: 'glm-5.2', createdAt: '', updatedAt: '', stats: { rounds: 1, compressed: false, toolCalls: 0 } },
      { id: 's3', task: '任务三', model: 'glm-5.2', createdAt: '', updatedAt: '', stats: { rounds: 1, compressed: false, toolCalls: 0 } },
    ]);
    const sim = simulate(<App cwd={CWD} />);
    await enterConversation(sim);
    await sim.type('/resume');
    await sim.enter();
    await sim.waitFor((f) => f.includes('恢复会话'));
    expect(sim.plain()).toMatch(/❯\s*任务一/); // 默认选中首项
    await sim.up(); // 首项 ↑ → 末项（循环）
    await sim.waitFor(() => true);
    expect(sim.plain()).toMatch(/❯\s*任务三/);
    expect(sim.plain()).not.toMatch(/❯\s*任务一/);
  });

  it('Enter 切换 → 历史内容可见（防假绿：真载入，非只关 picker）', async () => {
    mockedList.mockReturnValue([
      { id: 's1', task: '历史任务', model: 'glm-5.2', createdAt: '', updatedAt: '', stats: { rounds: 1, compressed: false, toolCalls: 0 } },
    ]);
    mockedLoad.mockReturnValue({
      id: 's1',
      task: '历史任务',
      model: 'glm-5.2',
      createdAt: '',
      updatedAt: '',
      messages: [
        { role: 'user', content: '历史提问' },
        { role: 'assistant', content: '历史回答' },
      ],
      stats: { rounds: 1, compressed: false, toolCalls: 0 },
    });
    const sim = simulate(<App cwd={CWD} />);
    await enterConversation(sim);
    await sim.type('/resume');
    await sim.enter();
    await sim.waitFor((f) => f.includes('恢复会话'));
    await sim.enter(); // 选中首项 → 载入
    await sim.waitFor((f) => f.includes('历史回答'));
    const f = sim.plain();
    expect(f).toContain('历史提问');
    expect(f).toContain('历史回答');
  });

  it('Esc 取消 → 不切换（loadSession 未调，当前会话不变）', async () => {
    mockedList.mockReturnValue([
      { id: 's1', task: '历史任务', model: 'glm-5.2', createdAt: '', updatedAt: '', stats: { rounds: 1, compressed: false, toolCalls: 0 } },
    ]);
    const sim = simulate(<App cwd={CWD} />);
    await enterConversation(sim);
    await sim.type('/resume');
    await sim.enter();
    await sim.waitFor((f) => f.includes('恢复会话'));
    await sim.esc();
    await sim.waitFor((f) => !f.includes('恢复会话'));
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it('切换后发新消息 → runAgentStream 收到 resumed.id=切换的会话（续接真相源，防假绿第3条）', async () => {
    mockedList.mockReturnValue([
      { id: 'target-session', task: '历史', model: 'glm-5.2', createdAt: '', updatedAt: '', stats: { rounds: 1, compressed: false, toolCalls: 0 } },
    ]);
    mockedLoad.mockReturnValue({
      id: 'target-session',
      task: '历史',
      model: 'glm-5.2',
      createdAt: '',
      updatedAt: '',
      messages: [{ role: 'user', content: '历史提问' }],
      stats: { rounds: 1, compressed: false, toolCalls: 0 },
    });
    const sim = simulate(<App cwd={CWD} />);
    await enterConversation(sim);
    await sim.type('/resume');
    await sim.enter();
    await sim.waitFor((f) => f.includes('恢复会话'));
    await sim.enter(); // 载入 target-session → switchSession 设 sessionRef
    await sim.waitFor((f) => f.includes('历史提问'));
    mockedRun.mockClear(); // 仅看续接这一次调用
    await sim.type('续接新消息');
    await sim.enter();
    await sim.waitFor(() => true);
    expect(mockedRun).toHaveBeenCalled();
    const lastCall = mockedRun.mock.calls[mockedRun.mock.calls.length - 1];
    const opts = lastCall[1] as { resumed?: { id: string } };
    expect(opts.resumed?.id).toBe('target-session');
  });
});

describe('REPL 人肉驱动 —— Ctrl+O 转录 pager（方向 B）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedRun.mockImplementation(async function* () {});
    mockedList.mockReturnValue([]);
    mockedRunLess.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ink-testing-library 用内部 stdout 渲染帧；process.stdout.write 是 app 直接写的
  // （清屏 / alternate screen），spy 它可观测 alternate 序列而不污染帧。
  const wroteSeq = (spy: ReturnType<typeof vi.spyOn>, seq: string): boolean =>
    spy.mock.calls.some((c) => String(c[0]).includes(seq));

  /** 造一次含 read_file 工具结果的对话：completedMessages 含折叠工具 → transcript 非空（进 pager）。
   *  新 format-transcript 逻辑：无折叠工具的纯对话 → 空串不进 pager，故 Ctrl+O 测试需 seeding 折叠工具。 */
  function runWithReadFile(): void {
    mockedRun.mockImplementation(async function* (text: string) {
      yield { type: 'start', task: text, model: 'glm-5.2', provider: 'glm' };
      yield { type: 'tool_call_start', id: 't1', name: 'read_file', input: { path: 'a.ts' } };
      yield { type: 'tool_result', id: 't1', name: 'read_file', content: '文件内容A', isError: false, input: { path: 'a.ts' } };
      yield { type: 'completed', rounds: 1, toolCalls: 1, reason: 'done', messages: [], sessionId: 's1', task: text, createdAt: '2026-01-01' };
    });
  }

  it('Ctrl+O 有消息 → 进 pager（写 1049h）→ 调 runLess → 出 pager（写 1049l）', async () => {
    mockedRunLess.mockResolvedValue(undefined);
    runWithReadFile(); // 造含折叠工具的消息（新逻辑：无折叠工具 → 空串不进 pager）
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const sim = simulate(<App cwd={CWD} />);
    await enterConversation(sim);
    await sim.waitFor((f) => f.includes('read_file')); // 等 read_file 落地进 completedMessages
    await sim.ctrlO();
    await sim.waitFor(() => wroteSeq(stdoutSpy, '\x1b[?1049h'));
    expect(mockedRunLess).toHaveBeenCalled(); // 进 pager 调 runLess
    await sim.waitFor(() => wroteSeq(stdoutSpy, '\x1b[?1049l')); // runLess resolve → 退出
    expect(wroteSeq(stdoutSpy, '\x1b[?1049l')).toBe(true);
  });

  it('空消息（/clear 后）→ 提示暂无内容，不进 pager（不调 runLess、不写 alternate）', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const sim = simulate(<App cwd={CWD} />);
    await enterConversation(sim);
    await sim.type('/clear');
    await sim.enter();
    await sim.waitFor(() => true); // 让 clear 落地（completedMessages=[]）
    await sim.ctrlO();
    await sim.waitFor((f) => f.includes('暂无内容可查看'));
    expect(mockedRunLess).not.toHaveBeenCalled();
    expect(wroteSeq(stdoutSpy, '\x1b[?1049h')).toBe(false);
  });

  it('runLess 失败 → error 提示 + finally 仍写 1049l（不卡在 alternate）', async () => {
    mockedRunLess.mockRejectedValue(new Error('less not found'));
    runWithReadFile(); // 造含折叠工具的消息（否则空串不进 pager，runLess 无从触发）
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const sim = simulate(<App cwd={CWD} />);
    await enterConversation(sim);
    await sim.waitFor((f) => f.includes('read_file'));
    await sim.ctrlO();
    await sim.waitFor((f) => f.includes('无法打开转录视图'));
    expect(wroteSeq(stdoutSpy, '\x1b[?1049l')).toBe(true); // finally 必切回主屏
  });
});
