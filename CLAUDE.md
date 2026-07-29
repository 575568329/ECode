# CLAUDE.md

> 本文件 = **跨项目通用规范**（§一~七）+ **记忆规则**（§八）+ **ECode 红线**（§九）。
> 项目状态 / 进度 / 决策记忆**不在本文件**，见 `docs/memory/`（git 跟踪，跨设备同步）。

---

## 🧭 AI 读取导航（会话开始先看这里）

**这是什么项目**：用 TS + Node.js 从零**手写** AI coding agent（学习项目，对标 Claude Code）。单包 CLI，核心是手写的 agent loop（不用 LangGraph 等框架）。完整规划见 `docs/00-学习型开发规划.md`。

**会话开始按顺序读**：
1. 本文件 **§九**（红线避坑）——必须遵守。
2. `docs/memory/MEMORY.md`——项目状态索引（进度/决策/踩坑），**跨设备同步靠它**。
3. 按需读 `docs/memory/` 下对应文件 + `docs/` 设计文档（动手前读相关方案）。

**常用命令**：

| 操作 | 命令 |
|------|------|
| 开发运行 | `npm run dev -- "任务"`（自动加载 `.env`；默认走 DeepSeek 兼容端点，见 `.env.example`） |
| 编译 | `npm run build`（tsc，strict） |
| 测试 | `npm test` / 单文件 `npx vitest run xxx.test.ts` / 按名 `npx vitest run -t "用例名"` |

**文件地图**：

| 位置 | 内容 |
|------|------|
| 本文件 §一~七 | 通用编码规范（设计哲学 / Java / Python / 前端 / TDD / 任务分解） |
| 本文件 §八 | 记忆系统规则（怎么读、怎么写、存哪） |
| 本文件 §九 | 红线避坑（包管理 / 密钥 / WSL↔Windows / 进程） |
| `docs/memory/` | 项目记忆（进度/决策/偏好/流程/踩坑），git 跟踪 |
| `docs/00~04*.md` | 设计文档（技术选型 / M1 方案 / SDK 参数 / 协议对比） |
| `docs/logs/` | 开发日志（按日期，手写时间线） |
| `docs/logs/runtime/` | 每次运行 agent 自动生成的全量调试日志 |
| `src/` | 源码：`index.ts`→`agent.ts`→`tools.ts`→`runtime-logger.ts` |

**给 AI 的硬约束**（违反会报错/踩坑）：

- **ESM**：import 必须带 `.js`（如 `from './agent.js'`），即使源文件是 `.ts`。
- **tsconfig strict** + `noUnusedLocals` / `noUnusedParameters`：未用的变量/参数会编译报错。
- **agent loop**（[src/agent.ts](src/agent.ts)）：`tool_result.tool_use_id` 必须配对 `tool_use.id`（不配对 API 400）；`messages` 是累加的，每轮传完整历史。
- **commit**：不出现任何 claude / `Co-Authored-By` 字样（见 §七）。

---

## 一、通用原则 (Universal Principles)

### 1.1 设计哲学

- **极简导向**：少即是美，如无必要勿增实体 (KISS & YAGNI)。
- **性能平衡**：不追求极致优化，但拒绝显而易见的性能陷阱（如循环查库、N+1 查询）。
- **防御式编程**：优先"卫语句 (Guard Clauses)"尽早返回，拒绝深层嵌套（最多 3 层）。
- **关注点分离**：每个模块/函数只做一件事，高内聚低耦合。
- **配置与依赖方向**：能代码运行时自探测的，就别让用户/终端/外部环境去配置。别把「能不能正常工作」寄托在你管不了的外部环境（环境变量注入、终端行为、用户手动配 env）上——外部依赖越多，静默失效的链路越长、越难排查。自探测自洽（self-contained）、零配置、失败可优雅降级。

### 1.2 通用编码规范

- **命名**：变量/函数用业务语义命名，禁止无意义缩写（循环索引 `i/j/k` 除外）。
- **异常处理**：禁止吞掉异常，禁止空 catch/except 块；异常信息必须包含上下文。
- **魔法值**：禁止裸数字/字符串散落在代码中，提取为常量或枚举。
- **注释**：解释 Why 而非 What；复杂业务逻辑必须写注释，显而易见的代码不写。

### 1.3 通用模式应用

- **策略模式**：`if-else > 3` 或复杂状态判断 → 重构为策略映射 (Map/Dict/Object)。
- **责任链/中间件**：多级校验、数据清洗场景优先使用。
- **Builder 模式**：参数 > 4 个的对象构建推荐使用。

### 1.4 任务执行流程

- **前置规划**：先规划（业务拆解 → 技术选型 → 流程梳理 → 方案输出）再编码。
- **后置总结**：任务完成后输出总结（实现思路、决策依据、优化点），除非用户明确不需要。
- **设计优先级**：需求优先聚焦接口设计（定义、入参出参、交互逻辑），数据库设计后置。
- **错误处理**：如果解决一个相同的问题,第一次没有解决掉从第二次重复解决开始就要上网查相关的信息,不要一直试错浪费时间和token.

### 1.5 职业视角与决策维度

- **架构师**：技术选型合理性、扩展性、长期演进。
- **资深开发**：代码可读性、执行效率、落地成本、最佳实践。
- **产品经理**：业务价值、时间成本、可行性。
- **底线**：成本可控、时间可预期、交付质量有保障。

### 1.6 文档管理

- 持久化文档放在项目 `docs/` 目录下（不存在则创建）。
- 命名规则：`YYYYMMDDHHMMSS_文档标题`。
- 不要每次都写文档，除非用户明确提出或任务复杂度确实需要。
- 注意日志,前后端都需要日志，保存到文件中,方便排查.

---

## 二、Java 领域 (Java Domain)

### 2.1 架构与分层

- 严格遵循职责分层（Controller → Service → Repository/Mapper），禁止跨层调用。
- 领域逻辑内聚在 Service 层，Controller 只做参数校验和结果包装。
- 追求自闭环：一个领域模块尽量不依赖其他领域的内部实现。

### 2.2 编码规范

- **类引用**：使用 import 导入，禁止代码中出现全限定类名。
- **数据对象策略**：
  - RPC/SDK 接口 (Dubbo/Feign)：使用普通 POJO + Lombok `@Data`，确保序列化兼容。
  - 内部逻辑/HTTP 层：推荐 Record（Java 16+），利用不可变性提升安全性。
- **数据库操作**：所有读写优先批量处理，禁止单条循环操作。
- **技术栈**：优先选择与当前项目 JDK 和 Spring Boot 版本兼容的依赖。

### 2.3 数据库表设计

- 禁用外键约束（分布式架构考量）。
- 必需审计字段：`create_by`, `insert_time`, `update_time`, `del_status`。
- 索引设计跟随查询场景，禁止盲目加索引。

### 2.4 常用约定

- 方法参数 > 3 个时封装为请求对象。
- Service 方法返回业务对象而非 Entity，做好 DTO 转换。
- 日志打印包含关键业务参数，敏感字段脱敏。

---

## 三、Python 领域 (Python Domain)

### 3.1 代码风格

- 遵循 PEP 8，行宽 120 字符。
- 所有函数/方法必须添加类型注解（Type Hints），包括返回值。
- 优先使用 `dataclass` 或 `Pydantic BaseModel` 定义数据结构，少用裸 dict 传递业务数据。

### 3.2 项目结构

- 按功能/领域组织包结构，避免单文件过大（建议单文件 < 500 行）。
- 配置管理使用环境变量 + `.env` 文件，禁止硬编码密钥和连接串。
- 依赖管理使用 `pyproject.toml`（优先）或 `requirements.txt`，锁定版本号。

### 3.3 常用约定

- 异步场景优先使用 `async/await`，避免混用同步阻塞调用。
- 列表/字典推导式适度使用，超过两层嵌套时改为显式循环。
- 使用 `pathlib.Path` 处理路径，不用字符串拼接。
- 上下文管理器 (`with`) 管理资源（文件、连接、锁）。
- f-string 格式化字符串（Python 3.6+）。

### 3.4 测试

- 测试框架统一 `pytest`。
- 关键业务逻辑需有单元测试覆盖，工具函数优先写测试。

---

## 四、前端领域 (Frontend Domain)

### 4.1 通用规范

- **TypeScript 优先**：所有新代码使用 TS，严格模式 (`strict: true`)，禁止 `any`（实在不得已用 `unknown`）。
- **组件设计**：单一职责，UI 组件与业务逻辑分离（容器组件 vs 展示组件）。
- **状态管理**：能用局部状态解决的不上全局状态；全局状态按领域拆分 store。
- **组件封装**: 能够封装成组件的都封装,最好所有组件都可以随时抽出来单独放入组件库

### 4.2 React 约定

本项目前端已于 2026-06-05 从 Vue 3 重构为 React（见 `docs/20260606003000_前端React重构总结.md`）。

- **框架**：React 19 + TypeScript + Vite
- **状态管理**：Zustand，按领域拆分 store（`taskStore`、`chatStore`、`uiStore` 等）
- **UI 组件**：shadcn/ui（Radix UI 无样式原语 + Tailwind CSS v4 + `tw-animate-css`）
- **样式**：Tailwind CSS v4 + CSS 变量双主题 token（亮/暗）+ `cn()` 工具函数
- **图标**：lucide-react
- **拖拽**：@dnd-kit/core
- **HTTP**：原生 fetch 封装（`api/http.ts`），不使用 axios
- **路由**：无 router —— 单页应用通过 `hidden` 属性切换视图，保持滚动/状态

**编码规范**：
- 函数组件 + Hooks，不使用 class 组件。
- 自定义 Hook 抽离可复用逻辑，命名 `useXxx`。
- `useEffect` 依赖数组必须完整声明，禁止空依赖数组执行有依赖的副作用。
- 列表渲染必须提供稳定唯一 `key`，禁止使用数组索引。
- 组件 Props 定义 interface，导出供外部使用。
- 大型组件（>300 行）拆分为子组件或提取自定义 Hook。

### 4.3 Vue 约定（已废弃）

> ⚠️ 本项目已于 2026-06-05 从 Vue 3 迁移到 React。此节仅保留作为历史参考，不再适用于当前代码库。

### 4.4 样式与 CSS

- 组件级样式使用 CSS Modules / Scoped CSS / CSS-in-JS，避免全局污染。
- 设计 Token（颜色、间距、字号）提取为 CSS 变量或主题常量，禁止硬编码。
- 响应式设计移动端优先 (mobile-first)，使用相对单位 (rem/em/%)。

### 4.5 工程化

- ESLint + Prettier 统一代码风格，提交前自动格式化。
- 路由懒加载，大型依赖按需导入 (tree-shaking)。
- 图片资源压缩，合理使用 WebP 格式和懒加载。
- API 请求层统一封装（拦截器处理 token、错误码、loading 状态）。

### 4.6 交互设计原则

- **操作路径最短化**：能一步完成的不要两步，避免让用户在多个界面/弹窗之间跳转。
- **直接触发原生能力**：文件/文件夹选择、日期选择等，优先调用系统原生控件（`<input type="file">`、`<input type="date">`），不要自己实现模拟版本。
- **减少中间态**：避免"打开弹窗 → 在弹窗里再点按钮 → 才触发真正操作"的多层嵌套，直接触发目标动作。
- **即时反馈**：操作后立即显示结果（成功/失败），不让用户猜测是否生效。

**反例**：点"浏览" → 打开自定义弹窗 → 弹窗里再点"打开系统选择器" → 选择文件夹（3步）  
**正例**：点"浏览" → 直接打开系统选择器 → 选择文件夹（2步）

---

## 五、测试驱动开发 (TDD Strategy)

### 5.1 TDD 核心流程

- 严格遵循 Red → Green → Refactor 循环：先写失败测试 → 最小实现通过 → 重构优化。
- 每个功能点先定义"什么算完成"（验收条件），再转化为测试用例。
- 测试粒度：单元测试覆盖核心逻辑，集成测试覆盖模块协作，E2E 测试覆盖关键链路。

### 5.2 curl 测试驱动（API 层 TDD）

适用于 HTTP 接口的快速验证，在接口开发过程中同步编写。

```bash
# 放置位置：项目根目录 tests/curl/ 或 tests/api/
# 命名规则：test_<模块>_<场景>.sh

# --- 示例：tests/curl/test_user_create.sh ---
#!/bin/bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"

echo "=== 测试：创建用户 - 正常场景 ==="
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/users" \
  -H "Content-Type: application/json" \
  -d '{"name": "test", "email": "test@example.com"}')

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -ne 200 ]; then
  echo "FAIL: 期望 200，实际 $HTTP_CODE"
  echo "Response: $BODY"
  exit 1
fi

echo "PASS"

echo "=== 测试：创建用户 - 参数缺失 ==="
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/users" \
  -H "Content-Type: application/json" \
  -d '{"name": ""}')

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
if [ "$HTTP_CODE" -ne 400 ]; then
  echo "FAIL: 期望 400，实际 $HTTP_CODE"
  exit 1
fi

echo "PASS"
echo "=== 全部通过 ==="
```

**约定：**
- 每个 curl 测试脚本必须包含正常场景和异常场景（至少各一个）。
- 使用 `set -euo pipefail` 确保失败立即退出。
- 支持环境变量覆盖 `BASE_URL`，方便多环境执行。
- 复杂断言（JSON 字段校验）使用 `jq` 提取判断。

### 5.3 原生单元测试 TDD

各语言测试框架与约定：

| 语言 | 框架 | 测试目录 | 命名规则 |
|------|------|----------|----------|
| Java | JUnit 5 + Mockito | `src/test/java/` | `XxxTest.java` / `XxxServiceTest.java` |
| Python | pytest | `tests/` | `test_xxx.py` |
| JS/TS | Vitest / Jest | `__tests__/` 或 `*.test.ts` | `xxx.test.ts` / `xxx.spec.ts` |

**编写原则：**
- 测试方法命名：`should_<预期行为>_when_<前置条件>`（或对应语言的惯用风格）。
- 每个测试只验证一个行为，禁止一个 test case 塞多个断言逻辑。
- Mock 外部依赖（数据库、HTTP、MQ），不 Mock 被测对象自身方法。
- 测试数据就近构造，禁止依赖共享可变状态。

### 5.4 Shell 脚本测试与自动化

```bash
# --- 示例：tests/run_all.sh（测试编排脚本）---
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASSED=0
FAILED=0

echo "=============================="
echo " Running All Tests"
echo "=============================="

for test_file in "$SCRIPT_DIR"/curl/test_*.sh; do
  echo ""
  echo "▶ Running: $(basename "$test_file")"
  if bash "$test_file"; then
    ((PASSED++))
  else
    ((FAILED++))
    echo "✗ FAILED: $(basename "$test_file")"
  fi
done

echo ""
echo "=============================="
echo " Results: $PASSED passed, $FAILED failed"
echo "=============================="

[ "$FAILED" -eq 0 ] || exit 1
```

**Shell 脚本约定：**
- 所有脚本头部加 `set -euo pipefail`。
- 提供 `run_all.sh` 作为统一入口，支持一键跑全部测试。
- 脚本输出清晰的 PASS/FAIL 标记和汇总统计。
- CI 环境可直接调用 `bash tests/run_all.sh` 集成。

### 5.5 TDD 工作节奏

1. 拿到需求 → 先写接口契约（入参、出参、状态码）
2. 根据契约写 curl 测试脚本（API 层红灯）
3. 写核心逻辑的单元测试（Service 层红灯）
4. 实现代码让测试变绿
5. 重构，保持测试全绿
6. 提交前执行 `run_all.sh` 确认无回归

---

## 六、大型复杂任务分解 (Complex Task Decomposition)

### 6.1 分解原则

- **自顶向下**：先看全局再拆局部，避免一头扎进细节。
- **交付粒度**：每个子任务必须有可验证的交付物（能跑的代码、能调的接口、能看的页面）。
- **依赖最小化**：子任务之间尽量解耦，可并行推进；有依赖的明确标注先后顺序。
- **单任务时间盒**：单个子任务控制在 30 分钟~2 小时可完成的粒度，超过则继续拆。

### 6.2 分解流程（五步法）

```
Step 1: 需求澄清
  └─ 明确业务目标、边界条件、验收标准
  └─ 产出：需求确认清单（含明确的 Done 定义）

Step 2: 架构草案
  └─ 技术选型、模块划分、核心流程图
  └─ 产出：模块依赖关系图 + 接口契约草案

Step 3: 任务拆解
  └─ 按模块/层级拆为可独立交付的子任务
  └─ 产出：任务清单（含优先级 P0/P1/P2、依赖关系、预估耗时）

Step 4: 逐个击破
  └─ 按优先级 + 依赖顺序逐个实现
  └─ 每个子任务走 TDD 流程（5.5 节）
  └─ 每完成一个子任务做一次阶段验证

Step 5: 集成收尾
  └─ 模块联调、端到端测试、边界场景补充
  └─ 产出：完成总结（决策记录、遗留问题、优化建议）
```

### 6.3 任务清单模板

在分解任务时使用如下格式输出：

```markdown
## 任务：<总体目标>

### 前置准备
- [ ] P0 | 需求澄清 & 接口契约定义 | 预估 30min

### 核心实现
- [ ] P0 | <子任务1：描述> | 依赖：无 | 预估 1h
- [ ] P0 | <子任务2：描述> | 依赖：子任务1 | 预估 1.5h
- [ ] P1 | <子任务3：描述> | 依赖：无 | 预估 45min

### 测试与联调
- [ ] P0 | 单元测试补充 | 依赖：核心实现完成 | 预估 1h
- [ ] P0 | curl 集成测试 | 依赖：核心实现完成 | 预估 30min
- [ ] P1 | 端到端验证 | 依赖：全部完成 | 预估 30min

### 收尾
- [ ] P2 | 代码审查 & 重构 | 预估 30min
- [ ] P2 | 文档输出（如需要）| 预估 20min
```

### 6.4 复杂度判断标准

什么时候需要启动正式的任务分解流程：

- 涉及 **3 个以上模块/服务** 的协作变更
- 预估开发时间 **> 4 小时**
- 涉及 **数据库表结构变更** + 业务逻辑变更的组合
- 需要 **多端联调**（前后端、多服务）
- 需求描述模糊，需要先做方案对齐

不满足以上条件的简单任务，直接走 TDD 流程即可，无需额外的分解仪式。

---

## 七、协作备忘 (Collaboration Notes)

- 我更倾向于先看方案再写代码，请在动手前先给出思路。
- 遇到模糊需求时主动追问，不要自行假设关键业务逻辑。
- 代码变更尽量最小化影响面，改动前评估关联影响。
- Git 提交信息遵循 Conventional Commits 格式：`feat:` / `fix:` / `refactor:` / `docs:` / `chore:`。
- **提交时机**：完成一个完整功能、修复完一个完整问题、或一个小版本里程碑达成后再提交，**禁止每改一行就 commit**。中间调试过程的小调整保留在工作树里,等都调通验证通过后一起提交,避免污染 git 历史和浪费资源。
- **commit**里面不要出现任何claude相关的内容.尤其是Co-Authored-By: Claude noreply@anthropic.com


永远使用中文与我对话

---

## 八、记忆系统集成 (Memory Integration)

### 8.1 记忆库架构

**项目内优先的记忆系统**：记忆文件存放在**本项目内**（`docs/memory/`），随 git 仓库跨设备同步——不依赖某台机器的本地目录（不同设备用户名/路径不一致会丢内容）。

- **主存储目录**：`docs/memory/`（纳入 git 跟踪，pull 即同步）
- **索引文件**：`docs/memory/MEMORY.md`（手动维护，每条一行摘要）
- **不依赖** OneDrive/Dropbox 或机器本地的 `~/.claude/`——那些路径跨设备对不上。

### 8.2 记忆分类

| 类型 | 目录/文件 | 说明 |
|------|----------|------|
| 偏好 | `preferences/` | 编码风格、工具选择、工作习惯 |
| 决策 | `decisions/` | 技术选型、架构决策及原因 |
| 流程 | `procedures/` | 操作流程（部署、调试、发布等可复用步骤） |
| 项目 | `projects/` | 项目上下文、进度、关键信息 |
| 调试 | `debugging.md` | 踩坑记录和解决方案 |

### 8.3 使用记忆的规则

**每次会话开始时：**
- 自动加载 `MEMORY.md` 前200行
- 根据当前任务加载相关分类文件

**处理任务时参考优先级：**
1. 偏好 → `memory/preferences/`
2. 决策记录 → `memory/decisions/`
3. 操作流程 → `memory/procedures/`
4. 项目上下文 → `memory/projects/`
5. 调试经验 → `memory/debugging.md`

### 8.4 记忆触发条件

**显式触发（用户明确要求）：**
- 用户说"记住"/"记录"/"添加到记忆"/"更新记忆"

**隐式触发（AI 自动检测，即时记录）：**
- 用户在3次以上对话中提到同一习惯或偏好
- 检测到明确的技术选型或架构决策
- 发现用户重复的工作流程模式
- 遇到用户反复遇到的错误并已解决

**定时触发：**
- 每周日晚上8点自动运行周总结

### 8.5 记忆更新流程

```
1. 检测到可记忆信息
   ├─ 检查是否已存在（避免重复）
   └─ 判断归属分类

2. 用户确认
   ├─ 简要说明要记录的内容
   └─ 请求用户确认

3. 写入记忆
   ├─ 写入对应分类文件
   └─ 更新 MEMORY.md 索引（一行摘要）
```

### 8.6 记忆维护

**定期清理（月度）：**
- 检查记忆是否过时，与当前项目状态对比
- 已完成项目的上下文归档或精简
- 过时的调试经验移除（问题已不存在）

**MEMORY.md 索引规范：**
- 每条索引一行，格式：`- [标题](文件路径) — 一句话摘要`
- 索引超过200行时，移除低优先级条目

### 8.7 安全注意事项

**禁止记录的内容：**
- API 密钥、密码、临时凭证
- 敏感个人信息
- 未脱敏的生产数据

**如检测到敏感信息：** 立即停止记录并通知用户


## 九、环境与避坑约定（红线）

> 通用坑，跨设备 / Windows ↔ WSL 混合环境均适用。

### 9.1 依赖与包管理

- **统一 npm**，禁用 pnpm / cnpm / yarn（pnpm 不支持 `workspaces`，monorepo 子包依赖装不上）。
- **换源 / 换网络环境前先删 `package-lock.json`**：lock 锁了旧源地址，公网/内网切换后会出现误导性的网络错误（如 `Exit handler never called!`），实际是源不可达。
- **monorepo 多 workspace 共享依赖（如 `vite`）版本范围须有交集**：否则 npm 给各 workspace 装多份 → build 报类型冲突（指向两份依赖）；统一到一份。

### 9.2 敏感信息

- 任何返回值含密钥 / 凭证的配置，**禁止透传到前端 / 打进日志**，统一走脱敏接口（如 `getMaskedConfig()`）。
- `.env` 及含密钥的运行时产物必须 gitignore（ECode 已忽略 `.env`、`.env.*`、`.ecode/`、`*.session.json`，`.env.example` 保留入库）。

### 9.3 WSL ↔ Windows 混合环境（核心）

构建/进程跑 Windows、Claude Code/MCP 跑 WSL 时，两边 `os.homedir()` 是**不同物理目录**：

- **不要散用 `os.homedir()` / `~` / `$HOME` 定位数据目录**——跨进程两套 home 必对不上（拉到空数据就是它）。统一走单一入口 `resolveDataDir()`，优先级 **显式 > env > 自探测对端 home > 默认 home**。
- **别用 WSLENV 桥接数据目录**：Windows Terminal 启动 wsl.exe 时用进程级 WSLENV（传 `WT_SESSION` 等）**覆盖**注册表 User 级，从 WT 启动的 WSL 永远拿不到桥接变量（`wsl --shutdown` 重启也没用）。**改用代码自探测**（`cmd.exe /c echo %USERPROFILE%` + `wslpath` 转路径，模块级缓存）。
- **原则：运行时自探测 > 外部环境注入**——自洽、clone 即用、不被宿主覆盖、失败优雅降级；环境注入依赖一长串外部前提，任一环失效就静默崩（呼应 1.1 节"配置与依赖方向"）。
- **`appendWindowsPath=false` 下别裸调 `cmd` / `powershell` / `wsl.exe`**：它们不在 WSL PATH 里，用绝对路径 `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`。
- **跨 Windows/WSL 共享 node_modules 的原生二进制会失败**：node_modules 在 Windows 装的，WSL 里跑构建会缺 `@rollup/rollup-linux-x64-gnu` 之类平台原生包。**在 node_modules 安装侧跑构建**，另一侧只做 `tsc` 类型检查。

### 9.4 进程与终端

- `spawn` / 终端 `start` 是 **fire-and-forget**，无法事后注入消息；`Failed to fetch` 类错误先查目标进程日志，别先怪网络。
