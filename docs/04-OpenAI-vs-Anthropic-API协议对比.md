# OpenAI vs Anthropic API 协议对比

> **目的**: 深入对比两家 LLM 的工具调用协议差异，为 M2 Provider 抽象层做准备
> **实验建议**: 先理解表格，再通过实际调用观察报文差异

---

## 一、核心差异总览

| 维度 | Anthropic (Claude) | OpenAI (GPT) |
|------|-------------------|--------------|
| **协议** | Messages API | Chat Completions API |
| **端点** | `POST /v1/messages` | `POST /v1/chat/completions` |
| **SDK** | `@anthropic-ai/sdk` | `openai` |
| **model 格式** | `claude-sonnet-4-20250514` | `gpt-4o` / `gpt-4o-mini` |
| **system 位置** | 顶层 `system` 字段 | `messages` 数组中的 `role: 'system'` |
| **工具调用标志** | content 中的 `tool_use` block | `assistant` 消息上的 `tool_calls` 字段 |
| **工具参数格式** | `input` → 对象 ✅ | `function.arguments` → JSON 字符串 ❌ |
| **工具结果回传** | `tool_result` block（在 user content 里） | `role: 'tool'` 独立消息 |
| **多工具一次返回** | 单个 content 数组多个 block | 单个 `tool_calls` 数组多个元素 |
| **终止信号** | `stop_reason: 'tool_use'` | `finish_reason: 'tool_calls'` |
| **结束信号** | `stop_reason: 'end_turn'` | `finish_reason: 'stop'` |
| **截断信号** | `stop_reason: 'max_tokens'` | `finish_reason: 'length'` |
| **Stream 事件** | `content_block_delta` / `content_block_stop` | `delta.tool_calls` / `delta.function_call` |

---

## 二、工具调用请求格式对比

### Anthropic — content block 形式

```typescript
// API 返回
{
  "content": [
    { "type": "text", "text": "让我看一下文件..." },           // 可选：思考过程
    {
      "type": "tool_use",                                      // 工具调用
      "id": "toolu_abc123",                                    // 唯一 ID
      "name": "read_file",                                     // 工具名
      "input": { "path": "./package.json" }                    // ✅ 直接是对象
    }
  ],
  "stop_reason": "tool_use"
}

// SDK 收到的类型
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: object }
```

### OpenAI — tool_calls 形式

```typescript
// API 返回
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "让我看一下文件...",                            // 可选：思考过程
      "tool_calls": [{                                          // ← 独立字段！
        "id": "call_xyz456",                                    // 唯一 ID
        "type": "function",
        "function": {
          "name": "read_file",                                  // 工具名
          "arguments": '{"path": "./package.json"}'              // ❌ 字符串，要 JSON.parse
        }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}

// SDK 收到的类型
type Choice = {
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: {
        name: string;
        arguments: string;  // JSON 字符串
      };
    }>;
  };
  finish_reason: 'stop' | 'tool_calls' | 'length';
};
```

### 关键区别

| 区别 | Anthropic | OpenAI |
|------|-----------|--------|
| **位置** | content 数组的一块 | message 的独立字段 `tool_calls` |
| **参数** | `input` 直接是对象 ✅ | `function.arguments` 是 JSON 字符串 ❌ |
| **ID 前缀** | `toolu_...` | `call_...` |
| **混合** | 文本 + 工具调用可在同个 content 数组 | content 和 tool_calls 是互斥的（content 为 null 时有 tool_calls） |

> 💡 **实验**: 用 `JSON.stringify(response.content, null, 2)` 打印 Anthropic 返回
> 对照 `JSON.stringify(response.choices[0].message, null, 2)` 打印 OpenAI 返回
> 观察两种格式的差异

---

## 三、工具结果回传格式对比

### Anthropic — 塞到 user message 的 content 数组里

```typescript
// 把工具执行结果作为下一轮 user 消息的一部分
{
  role: 'user',
  content: [
    {
      type: 'tool_result',
      tool_use_id: 'toolu_abc123',      // ← 必须和 tool_use.id 配对
      content: '{ "name": "ecode"... }', // 工具执行结果
      is_error: false,                   // 是否执行失败（可选）
    },
    // 可以在同一个 user 消息里加多个 tool_result + 文本
    {
      type: 'text',
      text: '基于以上内容，回答我...',
    },
  ],
}
```

### OpenAI — 独立的 tool 角色消息

```typescript
// 每个工具结果是单独一条消息
{
  role: 'tool',
  tool_call_id: 'call_xyz456',          // ← 必须和 tool_calls[].id 配对
  content: '{ "name": "ecode"... }',    // 工具执行结果
}

// tool 消息后面必须跟 assistant 或 user 消息
[
  { role: 'tool', tool_call_id: 'call_1', content: '结果1' },
  { role: 'tool', tool_call_id: 'call_2', content: '结果2' },
  { role: 'assistant', content: '基于以上结果...' },  // 或 user 消息
]
```

### 关键区别

| 维度 | Anthropic | OpenAI |
|------|-----------|--------|
| **消息角色** | `user`（tool_result 是 content block） | `'tool'`（独立角色） |
| **ID 字段名** | `tool_use_id` | `tool_call_id` |
| **多个工具结果** | 一个 user 消息多个 block | 多条 tool 消息 |
| **同时加文本** | 同一个 content 数组里放文本 block | 需要另一条 user 消息 |
| **错误标记** | `is_error: true` | 无标准字段（可 content 里传） |

> 💡 **实验**: 故意传错 `tool_use_id` / `tool_call_id`，观察 API 返回什么错误

---

## 四、System 消息位置

```typescript
// ─── Anthropic ───
// system 是顶层字段，不在 messages 里
const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-20250514',
  system: '你是一个 AI 编程助手。请用中文回答。',   // ← 这里
  messages: [
    { role: 'user', content: '你好' },
  ],
});

// ─── OpenAI ───
// system 是 messages 中 role: 'system' 的消息
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: '你是一个 AI 编程助手。请用中文回答。' },  // ← 在这里
    { role: 'user', content: '你好' },
  ],
});
```

---

## 五、完整的消息序列对比

以"读 package.json 告诉我依赖"为例：

### Anthropic 消息序列

```
Round 1:
  user:    "读 package.json 告诉我依赖"

Round 2 (LLM 返回 tool_use):
  assistant: content=[
    { type: 'text', text: '好的，让我先读文件...' },
    { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: './package.json' } }
  ]
  user: content=[
    { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"dependencies": {"express": "^4"}}' }
  ]

Round 3 (LLM 返回 end_turn):
  assistant: "好的，package.json 的依赖包括..."
```

### OpenAI 消息序列

```
Round 1:
  user:    "读 package.json 告诉我依赖"
  (system 在 messages[0])

Round 2 (LLM 返回 tool_calls):
  assistant: {
    content: null,                    // ← 注意：有 tool_calls 时 content 可为 null
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"./package.json"}' } }
    ]
  }
  tool: { tool_call_id: 'call_1', content: '{"dependencies": {"express": "^4"}}' }

Round 3 (LLM 返回 stop):
  assistant: "好的，package.json 的依赖包括..."
```

---

## 六、Streaming 对比

### Anthropic Stream

```
事件流:
  message_start
  content_block_start (index=0, type=text)
  content_block_delta (delta: { type: 'text_delta', text: '好的' })
  content_block_delta (delta: { type: 'text_delta', text: '让我' })
  content_block_stop
  content_block_start (index=1, type=tool_use)
  content_block_delta (delta: { type: 'input_json_delta', partial_json: '{"pat' })
  content_block_delta (delta: { type: 'input_json_delta', partial_json: 'h":".' })
  content_block_stop
  message_delta (delta: { stop_reason: 'tool_use' })
  message_stop
```

### OpenAI Stream

```
事件流:
  choices[0].delta: { role: 'assistant', content: null }
  choices[0].delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }] }
  choices[0].delta: { tool_calls: [{ index: 0, function: { arguments: '{"pat' } }] }
  choices[0].delta: { tool_calls: [{ index: 0, function: { arguments: 'h":".' } }] }
  choices[0].finish_reason: 'tool_calls'
```

### 关键区别

| 维度 | Anthropic | OpenAI |
|------|-----------|--------|
| **事件结构** | 按 content block 维度组织（block start/delta/stop） | 按 token 维度组织（delta 持续叠加） |
| **tool 参数流式** | `input_json_delta` 累加 partial JSON | `function.arguments` 直接字符串拼接 |
| **完整 tool_use** | 非流式返回时才能拿到完整 input | 同上 |
| **实现复杂度** | 中等（事件模型层次清晰） | 较低（简单拼接即可） |

---

## 七、错误响应对比

```typescript
// ─── Anthropic ───
{
  "error": {
    "type": "authentication_error",
    "message": "Invalid API key"
  }
}
// HTTP 401

// ─── OpenAI ───
{
  "error": {
    "message": "Incorrect API key provided",
    "type": "invalid_request_error",
    "param": null,
    "code": "invalid_api_key"
  }
}
// HTTP 401
```

### 错误类型映射

| 含义 | Anthropic | OpenAI | HTTP |
|------|-----------|--------|------|
| 无效请求 | `invalid_request_error` | `invalid_request_error` | 400 |
| 认证失败 | `authentication_error` | `authentication_error` | 401 |
| 权限不足 | `permission_error` | `permissions_error` | 403 |
| 资源不存在 | `not_found_error` | `not_found_error` | 404 |
| 请求冲突 | — | `conflict_error` | 409 |
| 请求超限 | `rate_limit_error` | `rate_limit_error` | 429 |
| 服务端错误 | `api_error` | `server_error` | 500 |
| 服务不可用 | `overloaded_error` | — | 529 |

---

## 八、工具定义格式对比

```typescript
// ─── Anthropic ───
{
  name: 'read_file',
  description: '读取文件内容',
  input_schema: {                          // ⚠️ 字段名不同
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
    },
    required: ['path'],
  },
}

// ─── OpenAI ───
{
  type: 'function',                        // ⚠️ OpenAI 需要 type: 'function'
  function: {                              // ⚠️ 嵌套在 function 里
    name: 'read_file',
    description: '读取文件内容',
    parameters: {                          // ⚠️ 字段名不同
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
      },
      required: ['path'],
    },
  },
}
```

### 工具定义差异总结

| Anthropic | OpenAI |
|-----------|--------|
| 顶层是工具本身 | 嵌套在 `{ type: 'function', function: {...} }` 里 |
| `input_schema` | `parameters` |
| — | 额外 `type: 'function'` |

---

## 九、Provider 抽象层的设计思路（M2 预告）

M2 要实现的 Provider 抽象层，核心就是抹平上述所有差异：

```typescript
// 统一接口（M2 预想）
interface ModelProvider {
  send(messages: Message[], options: SendOptions): Promise<ModelResponse>;
}

interface ModelResponse {
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;  // 统一为对象，不管底层是 string 还是 object
  }>;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage: { inputTokens: number; outputTokens: number };
}

// ClaudeProvider：把 Anthropic 的协议转成统一接口
// OpenAIProvider：把 OpenAI 的协议转成统一接口（包括 JSON.parse(arguments)）
```

---

## 十、实验清单

### 实验 1：观察 Anthropic 完整报文
把 `src/agent.ts` 里的 `const response = await anthropic.messages.create({...})` 之后加一行：
```typescript
console.log(JSON.stringify(response, null, 2));
```
观察 `stop_reason`、`content` 数组结构、`usage`

### 实验 2：测试 tool_use id 不配对
把 `src/agent.ts` 中的 `tool_use_id: toolUse.id` 改成随便改个值，看返回什么错误

### 实验 3：测试多工具调用
让 LLM 同时做读文件和查目录，观察一次返回多个 tool_use block

### 实验 4：测试 tool_choice
试 `{ type: 'any' }` 和 `{ type: 'tool', name: 'read_file' }`，观察 LLM 的行为变化

### 实验 5：对比 OpenAI（M2 时做）
拿到 OpenAI 的 Key 后，同样的任务用 OpenAI API 调一次，对比返回报文结构

---

**创建时间**: 2026-07-28  
**关联文档**: `docs/03-Anthropic-SDK-参数详解.md`  
**M2 关联**: 本文档是 M2 Provider 抽象层的需求文档和设计依据
