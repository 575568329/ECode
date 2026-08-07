import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveSession,
  loadSession,
  listSessions,
  latestSessionId,
  taskToSlug,
  SessionNotFoundError,
} from '../src/session.js';
import type { ECodeSession } from '../src/session.js';

// ============================================================
// Session 持久化测试(P4)—— 纯数据层
// ============================================================
// 设计见 docs/里程碑/M3-实施方案.md §3.4 / §6。tmpdir 隔离,不污染真实项目目录。
// ============================================================

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ecode-session-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 构造一个合法 session(可覆盖字段) */
function makeSession(overrides?: Partial<ECodeSession>): ECodeSession {
  return {
    id: '20260803143022',
    task: '改登录bug',
    model: 'test-model',
    messages: [{ role: 'user', content: '改登录bug' }],
    createdAt: '2026-08-03T14:30:22.000Z',
    updatedAt: '2026-08-03T14:30:22.000Z',
    stats: { rounds: 0, compressed: false, toolCalls: 0 },
    ...overrides,
  };
}

// ============================================================
// taskToSlug(决策④:中文保留 + 非法字符→- + 截断 30)
// ============================================================
describe('taskToSlug', () => {
  it('中文 + 无特殊字符 → 原样保留', () => {
    expect(taskToSlug('改登录bug')).toBe('改登录bug');
  });

  it('空白与路径分隔符 → 合并为单个 -', () => {
    expect(taskToSlug('改 src/agent.ts 的压缩逻辑')).toBe('改-src-agent.ts-的压缩逻辑');
  });

  it('所有非法字符 [\\/:*?"<>|] → -', () => {
    expect(taskToSlug('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  it('连续分隔符折叠为单个 -', () => {
    expect(taskToSlug('改???登录')).toBe('改-登录');
  });

  it('超过 30 字符 → 截断到 30(并去掉尾部 -)', () => {
    const long = '这是一个非常非常非常非常非常非常非常非常非常非常非常长的任务描述要被截断';
    const slug = taskToSlug(long);
    expect(slug.length).toBeLessThanOrEqual(30);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('全非法/空白 → 回退 "session"', () => {
    expect(taskToSlug('   ')).toBe('session');
    expect(taskToSlug('???')).toBe('session');
  });
});

// ============================================================
// saveSession / loadSession 往返
// ============================================================
describe('saveSession + loadSession', () => {
  it('save → load 往返一致(messages 结构不变)', () => {
    const session = makeSession({
      messages: [
        { role: 'user', content: '任务' },
        { role: 'assistant', content: [{ type: 'text', text: '回复' }] },
      ],
    });
    const filePath = saveSession(session, dir);
    expect(existsSync(filePath)).toBe(true);

    const loaded = loadSession(session.id, dir);
    expect(loaded).toEqual(session);
  });

  it('文件名 = <id>_<slug>.json', () => {
    const filePath = saveSession(makeSession({ task: '改登录bug' }), dir);
    expect(filePath.endsWith(`${join('', '20260803143022_改登录bug.json')}`)).toBe(true);
  });

  it('save 不 mutate 原 session 对象', () => {
    const session = makeSession();
    const snapshot = JSON.parse(JSON.stringify(session));
    saveSession(session, dir);
    expect(session).toEqual(snapshot);
  });

  it('baseDir 不存在 → 自动创建(mkdir recursive)', () => {
    const nested = join(dir, 'a', 'b', 'c');
    const filePath = saveSession(makeSession(), nested);
    expect(existsSync(filePath)).toBe(true);
  });

  it('原子写:save 后无残留 .tmp 文件', () => {
    saveSession(makeSession(), dir);
    const tmpLeftover = existsSync(join(dir, '20260803143022_改登录bug.json.tmp'));
    expect(tmpLeftover).toBe(false);
  });

  it('同 id 二次 save → 覆盖原文件(不产生 -2,内容为最新)', () => {
    // 先落第一次
    saveSession(makeSession(), dir);
    // 同 id 二次 save(续接/更新语义)→ 覆盖原文件
    const updated = makeSession({
      updatedAt: '2026-08-03T15:00:00.000Z',
      stats: { rounds: 2, compressed: false, toolCalls: 1 },
    });
    const filePath = saveSession(updated, dir);
    // 同 id = 同一会话 = 覆盖,不产生 -2(对齐 Claude Code 纯 id 覆盖语义)
    expect(filePath.endsWith('20260803143022_改登录bug.json')).toBe(true);
    expect(existsSync(join(dir, '20260803143022_改登录bug-2.json'))).toBe(false);
    // 覆盖后读到的是最新内容
    const loaded = loadSession('20260803143022', dir);
    expect(loaded.updatedAt).toBe('2026-08-03T15:00:00.000Z');
    expect(loaded.stats.rounds).toBe(2);
  });

  it('同 id 不同 task(slug 碰撞) → 清理旧文件 + 覆盖', () => {
    // 模拟旧 timestampId 秒级碰撞：同 id + 不同 task → 不同 slug → 不同文件
    const id = '20260803143022';
    // 先写一个 task="打招呼"
    saveSession(makeSession({ id, task: '打招呼' }), dir);
    // 再写同 id + task="读代码" → slug 不同，触发碰撞检测
    const filePath = saveSession(makeSession({ id, task: '读代码' }), dir);
    // 应只存在一个文件（新的），旧的被清理
    const files = readdirSync(dir).filter((f) => f.startsWith(`${id}_`));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${id}_读代码.json`);
    // loadSession 返回最新数据
    const loaded = loadSession(id, dir);
    expect(loaded.task).toBe('读代码');
  });
});

// ============================================================
// loadSession 错误路径
// ============================================================
describe('loadSession 错误处理', () => {
  it('id 不存在 → 抛 SessionNotFoundError', () => {
    expect(() => loadSession('19700101000000', dir)).toThrow(SessionNotFoundError);
  });

  it('损坏 JSON → 抛错(含文件路径)', () => {
    const filePath = join(dir, '20260803143022_改登录bug.json');
    writeFileSync(filePath, '{ 这不是合法 json }}}', 'utf-8');
    expect(() => loadSession('20260803143022', dir)).toThrow(/20260803143022|JSON|解析/i);
  });
});

// ============================================================
// listSessions
// ============================================================
describe('listSessions', () => {
  it('按 updatedAt 倒序排列', () => {
    saveSession(makeSession({ id: '20260803100000', task: '早', updatedAt: '2026-08-03T10:00:00.000Z' }), dir);
    saveSession(makeSession({ id: '20260803140000', task: '中', updatedAt: '2026-08-03T14:00:00.000Z' }), dir);
    saveSession(makeSession({ id: '20260803180000', task: '晚', updatedAt: '2026-08-03T18:00:00.000Z' }), dir);
    const list = listSessions(dir);
    expect(list.map((s) => s.id)).toEqual(['20260803180000', '20260803140000', '20260803100000']);
  });

  it('返回 Summary(不含 messages 字段)', () => {
    saveSession(makeSession({ messages: [{ role: 'user', content: '秘密内容' }] }), dir);
    const list = listSessions(dir);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('messages');
    expect(list[0]).toHaveProperty('id');
    expect(list[0]).toHaveProperty('task');
    expect(list[0]).toHaveProperty('stats');
  });

  it('跳过损坏文件,不崩(末尾提示)', () => {
    saveSession(makeSession({ id: '20260803100000', task: '好的' }), dir);
    writeFileSync(join(dir, '20260803120000_坏.json'), '{ 损坏', 'utf-8');
    const list = listSessions(dir);
    // 只返回合法的那个
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('20260803100000');
  });

  it('空目录 → 返回 []', () => {
    expect(listSessions(dir)).toEqual([]);
  });
});

// ============================================================
// latestSessionId
// ============================================================
describe('latestSessionId', () => {
  it('返回 updatedAt 最新的 id', () => {
    saveSession(makeSession({ id: '20260803100000', updatedAt: '2026-08-03T10:00:00.000Z' }), dir);
    saveSession(makeSession({ id: '20260803180000', updatedAt: '2026-08-03T18:00:00.000Z' }), dir);
    expect(latestSessionId(dir)).toBe('20260803180000');
  });

  it('空目录 → undefined', () => {
    expect(latestSessionId(dir)).toBeUndefined();
  });
});

// ============================================================
// 续接:复用原 id 续写同一文件(决策③A)
// ============================================================
describe('续接(复用原 id)', () => {
  it('save → load → append 新任务 → save(同 id) → load:history 连续且 id 不变', () => {
    // 第一次会话
    const s1 = makeSession({ id: '20260803143022', task: '改登录bug' });
    saveSession(s1, dir);

    // 续接:加载历史,追加新任务消息,复用原 id 续写
    const loaded = loadSession('20260803143022', dir);
    const continuedMessages = [
      ...loaded.messages,
      { role: 'user', content: '再改一下样式' } as const,
    ];
    const s2: ECodeSession = {
      ...loaded,
      messages: continuedMessages,
      updatedAt: '2026-08-03T15:00:00.000Z',
      stats: { ...loaded.stats, rounds: loaded.stats.rounds + 3 },
    };
    const filePath = saveSession(s2, dir);

    // 复用原 id → 写回同一文件(不产生 -2)
    expect(filePath.endsWith('20260803143022_改登录bug.json')).toBe(true);
    expect(existsSync(join(dir, '20260803143022_改登录bug-2.json'))).toBe(false);

    // 再次加载:history 连续,新任务在尾部,id/task 不变
    const reloaded = loadSession('20260803143022', dir);
    expect(reloaded.id).toBe('20260803143022');
    expect(reloaded.task).toBe('改登录bug'); // 首句任务保持不变
    expect(reloaded.messages).toHaveLength(2);
    expect((reloaded.messages[1] as { content: string }).content).toBe('再改一下样式');
  });
});
