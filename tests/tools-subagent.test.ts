// 阶段1 子代理：Task 工具（createTaskTool）测试。
// 覆盖：extractFinalText 取末尾 assistant 文本；深度超限拒绝派发；递归回收结论（黑盒）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTaskTool, extractFinalText } from '../src/tools/subagent.js';
import { AllowList } from '../src/permission.js';
import { makeIsolatedRoot } from './helpers/isolated-dirs.js';
import type { AgentEvent } from '../src/agent-events.js';
import type { ECodeMessage, ECodeStreamPart, ModelProvider, ChatRequest } from '../src/providers/types.js';

/** mock provider：stream 产出固定 chunk 流（同 agent-stream.test.ts 模式）。 */
function mockProvider(parts: ECodeStreamPart[]): ModelProvider {
  return {
    name: 'mock',
    protocol: 'openai',
    baseURL: 'http://mock',
    complete: vi.fn(async () => ({
      content: [{ type: 'text', text: '压缩摘要' }],
      stopReason: { unified: 'stop' },
      usage: { inputTokens: 0, outputTokens: 0 },
    })),
    stream: async function* (_req: ChatRequest): AsyncIterable<ECodeStreamPart> {
      for (const p of parts) yield p;
    },
  };
}

/** spy provider：捕获 stream 收到的 model（验证子代理路由派发的模型），其余同 mockProvider。 */
function spyProvider(seen: { current?: string }): ModelProvider {
  return {
    name: 'mock',
    protocol: 'openai',
    baseURL: 'http://mock',
    complete: vi.fn(async () => ({
      content: [{ type: 'text', text: 'x' }],
      stopReason: { unified: 'stop' },
      usage: { inputTokens: 0, outputTokens: 0 },
    })),
    stream: async function* (req: ChatRequest): AsyncIterable<ECodeStreamPart> {
      seen.current = req.model;
      yield { type: 'text_delta', text: '子代理的结论' };
      yield { type: 'stop', reason: { unified: 'stop', raw: 'stop' } };
    },
  };
}

const textMsg = (text: string): ECodeMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});

// 隔离根目录：createTaskTool 的 execute 会真实跑子代理 runAgentStream（落盘 session + runtime-log），
// 全部重定向到 tmpdir，不污染真实 .ecode/sessions/ 和 docs/logs/runtime/。
let root: string;
beforeEach(() => {
  root = makeIsolatedRoot();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('extractFinalText', () => {
  it('取末尾 assistant 的 text', () => {
    const msgs: ECodeMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'q' }] }, textMsg('final answer')];
    expect(extractFinalText(msgs)).toBe('final answer');
  });

  it('跳过 tool_use，只取 text 块', () => {
    const msgs: ECodeMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 't', input: {} }] },
      textMsg('conclusion'),
    ];
    expect(extractFinalText(msgs)).toBe('conclusion');
  });

  it('取「最末」assistant（多个 assistant 时取最后一条）', () => {
    const msgs: ECodeMessage[] = [textMsg('first'), textMsg('second')];
    expect(extractFinalText(msgs)).toBe('second');
  });

  it('无 assistant text → 空串', () => {
    expect(extractFinalText([{ role: 'user', content: [{ type: 'text', text: 'q' }] }])).toBe('');
  });
});

describe('createTaskTool', () => {
  it('是名为 Task 的 dangerous 工具', () => {
    const tool = createTaskTool({ system: 's', allow: new AllowList(), getPermissionMode: () => 'default', depth: 0 });
    expect(tool.name).toBe('Task');
    expect(tool.dangerous).toBe(true);
    expect(tool.execute).toBeDefined();
  });

  it('深度超限 → isError 拒绝派发，不递归（防递归爆炸）', async () => {
    const provider = mockProvider([{ type: 'text_delta', text: '不应被调用' }, { type: 'stop', reason: { unified: 'stop', raw: 'stop' } }]);
    const tool = createTaskTool({ system: 's', allow: new AllowList(), getPermissionMode: () => 'default', provider, depth: 1, maxDepth: 1 });
    const res = await tool.execute!({ description: 'd', prompt: 'p' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('嵌套深度超限');
    // 没递归 → provider.stream 未被消费（complete 也未调用）
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('子代理递归 → 黑盒回收最终结论文本', async () => {
    const subProvider = mockProvider([
      { type: 'text_delta', text: '子代理的结论' },
      { type: 'stop', reason: { unified: 'stop', raw: 'stop' } },
    ]);
    const tool = createTaskTool({
      system: 's',
      allow: new AllowList(),
      getPermissionMode: () => 'default',
      provider: subProvider,
      model: 'mock-model',
      depth: 0,
      sessionBaseDir: root,
      runtimeLogBaseDir: root,
    });
    const res = await tool.execute!({ description: 'd', prompt: '分析这些文件' });
    expect(res.isError).toBe(false);
    expect(res.content).toBe('子代理的结论');
  });

  it('子代理产出空文本 → 回退提示（不返回空串迷惑主 LLM）', async () => {
    const subProvider = mockProvider([{ type: 'stop', reason: { unified: 'stop', raw: 'stop' } }]);
    const tool = createTaskTool({
      system: 's',
      allow: new AllowList(),
      getPermissionMode: () => 'default',
      provider: subProvider,
      model: 'mock-model',
      depth: 0,
      sessionBaseDir: root,
      runtimeLogBaseDir: root,
    });
    const res = await tool.execute!({ description: 'd', prompt: 'p' });
    expect(res.isError).toBe(false);
    expect(res.content).toContain('未产出文本结论');
  });

  it('子代理 model 走 subagent 场景路由（routingConfig.rules.subagent 派 cheap alias）', async () => {
    const seen: { current?: string } = {};
    const subProvider = spyProvider(seen);
    const tool = createTaskTool({
      system: 's',
      allow: new AllowList(),
      getPermissionMode: () => 'default',
      provider: subProvider,
      model: 'main-model',
      routingConfig: {
        aliases: { cheap: { provider: 'mock', model: 'cheap-model' } },
        rules: { subagent: 'cheap' },
        defaultTarget: { provider: 'mock', model: 'main-model' },
        complexityRouting: false,
      },
      depth: 0,
      sessionBaseDir: root,
      runtimeLogBaseDir: root,
    });
    await tool.execute!({ description: 'd', prompt: 'p' });
    // 子代理 stream 收到路由派发的 cheap-model（非主 main-model），证明 subagent 场景路由生效。
    expect(seen.current).toBe('cheap-model');
  });

  it('routingConfig 传入时走路由分支（无规则→defaultTarget，不回退 ctx.model）', async () => {
    const seen: { current?: string } = {};
    const subProvider = spyProvider(seen);
    const tool = createTaskTool({
      system: 's',
      allow: new AllowList(),
      getPermissionMode: () => 'default',
      provider: subProvider,
      model: 'main-model',
      routingConfig: {
        aliases: {},
        rules: {},
        defaultTarget: { provider: 'mock', model: 'fallback-model' },
        complexityRouting: false,
      },
      depth: 0,
      sessionBaseDir: root,
      runtimeLogBaseDir: root,
    });
    await tool.execute!({ description: 'd', prompt: 'p' });
    // 无规则无显式 → defaultTarget.model（路由分支）；若回退 ctx.model 会是 main-model。
    expect(seen.current).toBe('fallback-model');
  });
});

describe('createTaskTool · 路由元数据 metadata（R3）', () => {
  it('rules.subagent 路由 → metadata { routingSource: rule, model, provider }', async () => {
    const seen: { current?: string } = {};
    const subProvider = spyProvider(seen);
    const tool = createTaskTool({
      system: 's',
      allow: new AllowList(),
      getPermissionMode: () => 'default',
      provider: subProvider,
      model: 'main-model',
      routingConfig: {
        aliases: { cheap: { provider: 'mock', model: 'cheap-model' } },
        rules: { subagent: 'cheap' },
        defaultTarget: { provider: 'mock', model: 'main-model' },
        complexityRouting: false,
      },
      depth: 0,
      sessionBaseDir: root,
      runtimeLogBaseDir: root,
    });
    const res = await tool.execute!({ description: 'd', prompt: 'p' });
    expect(res.metadata).toEqual({ model: 'cheap-model', provider: 'mock', routingSource: 'rule' });
  });

  it('complexityRouting=true + complex 任务 → metadata routingSource: complexity', async () => {
    const seen: { current?: string } = {};
    const subProvider = spyProvider(seen);
    const tool = createTaskTool({
      system: 's',
      allow: new AllowList(),
      getPermissionMode: () => 'default',
      provider: subProvider,
      model: 'main-model',
      routingConfig: {
        aliases: {
          strong: { provider: 'mock', model: 'strong-model' },
          reasoning: { provider: 'mock', model: 'reasoning-model' },
        },
        rules: {},
        defaultTarget: { provider: 'mock', model: 'main-model' },
        complexityRouting: true,
        complexity: { complex: 'reasoning', medium: 'strong' },
      },
      depth: 0,
      sessionBaseDir: root,
      runtimeLogBaseDir: root,
    });
    const res = await tool.execute!({ description: 'd', prompt: '重构整个模块' });
    expect(res.metadata?.routingSource).toBe('complexity');
    expect(res.metadata?.model).toBe('reasoning-model');
  });

  it('无 routingConfig → metadata 不填（向后兼容）', async () => {
    const subProvider = mockProvider([
      { type: 'text_delta', text: '结论' },
      { type: 'stop', reason: { unified: 'stop', raw: 'stop' } },
    ]);
    const tool = createTaskTool({
      system: 's',
      allow: new AllowList(),
      getPermissionMode: () => 'default',
      provider: subProvider,
      model: 'mock-model',
      depth: 0,
      sessionBaseDir: root,
      runtimeLogBaseDir: root,
    });
    const res = await tool.execute!({ description: 'd', prompt: 'p' });
    expect(res.metadata).toBeUndefined();
  });
});

describe('createTaskTool · 跨 provider 降级（§9.3）', () => {
  it('落点 provider 建立失败 → 降级主 provider + 清 routingSource（非 isError）', async () => {
    const seen: { current?: string } = {};
    const subProvider = spyProvider(seen);
    const tool = createTaskTool({
      system: 's',
      allow: new AllowList(),
      getPermissionMode: () => 'default',
      provider: subProvider,
      model: 'main-model',
      routingConfig: {
        // 落点 provider='other' ≠ 主 'mock' → 进跨 provider 分支；
        //   createProvider('nonexistent-model') 因模型未配置 throw → 降级。
        aliases: { cheap: { provider: 'other', model: 'nonexistent-model' } },
        rules: { subagent: 'cheap' },
        defaultTarget: { provider: 'mock', model: 'main-model' },
        complexityRouting: false,
      },
      depth: 0,
      sessionBaseDir: root,
      runtimeLogBaseDir: root,
    });
    const res = await tool.execute!({ description: 'd', prompt: 'p' });
    // 非 isError：降级后子代理仍跑（回退主 provider），只是没按落点执行。
    expect(res.isError).toBe(false);
    // routingSource 清空 → 不填 metadata（避免 UI 气泡标注误导：实际走了主 provider）。
    expect(res.metadata).toBeUndefined();
  });
});

describe('createTaskTool · session 隔离落盘', () => {
  it('子代理 session + runtime-log 均落到 <root>/_subagents,主 root 顶层无散落', async () => {
    const subProvider = mockProvider([
      { type: 'text_delta', text: '结论' },
      { type: 'stop', reason: { unified: 'stop', raw: 'stop' } },
    ]);
    const tool = createTaskTool({
      system: 's',
      allow: new AllowList(),
      getPermissionMode: () => 'default',
      provider: subProvider,
      model: 'mock-model',
      depth: 0,
      sessionBaseDir: root,
      runtimeLogBaseDir: root,
    });
    await tool.execute!({ description: 'd', prompt: '分析这些文件' });

    // 子代理 session 落到 _subagents 子目录(subagentBaseDir 隔离)
    const subDir = join(root, '_subagents');
    expect(existsSync(subDir)).toBe(true);
    expect(readdirSync(subDir).some((f) => f.endsWith('.json'))).toBe(true);

    // 主 root 顶层无散落 .json → listSessions(root) 看不到子代理碎片
    const topLevelJson = readdirSync(root).filter((f) => f.endsWith('.json'));
    expect(topLevelJson).toHaveLength(0);

    // runtime-log 同样隔离:_subagents 下有日期目录(子代理 .md 落其内,不淹主日志目录)
    const subEntries = readdirSync(subDir);
    expect(subEntries.some((f) => /^\d{4}-\d{2}-\d{2}$/.test(f))).toBe(true);
  });
});
