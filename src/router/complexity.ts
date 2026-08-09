// ============================================================
// 启发式复杂度评估（M6 阶段D 模型路由 · §10）—— 零 LLM 成本、可解释
// ============================================================
// 评估时尚未读代码，故用「任务描述」级信号（非代码圈复杂度）：
// 中英关键词 + 长度 + 改动范围 + 工具数 → simple/medium/complex。
// 关键词内置中英双语（用户中文任务 + 代码英文关键词均覆盖）；用户可在 config complexityKeywords 追加（§11）。
// 起步用简单启发式（Google ML Rules：simple heuristic ships, complex heuristic unmaintainable）。

export type Complexity = 'simple' | 'medium' | 'complex';

/** 倾向 complex 的关键词（推理/综合/大改）：中英双语。 */
const COMPLEX_KEYWORDS = [
  '重构', 'refactor', '优化', 'optimize', '设计', 'design', '架构', 'architecture',
  '迁移', 'migrate', '重写', 'rewrite', '实现', 'implement', '集成', 'integrate',
  '新增', 'feature', '调试', 'debug', '改造', '梳理',
];

/** 倾向 simple 的关键词（片段查找/单点）：中英双语。 */
const SIMPLE_KEYWORDS = [
  '错别字', 'typo', '重命名', 'rename', '格式化', 'format', '检查', 'lint',
  '列表', 'list', '读取', '查看', 'read', '状态', 'status', '是什么', 'what is',
  '显示', 'show', '计数', 'count', '查找', 'grep',
];

/** 长任务阈值（token 估算）：超过则倾向 complex。length/2 粗估（零依赖，对齐 §4）。 */
const LONG_TOKEN_THRESHOLD = 50;
/** 高工具数阈值：子任务预估调用 ≥N 工具 → 倾向 complex。 */
const HIGH_TOOL_COUNT = 5;

/**
 * 启发式评估任务复杂度（simple/medium/complex）。
 *
 * @param taskDesc 任务描述（用户输入或子任务描述）
 * @param ctx.toolCount 预估工具调用数（可选，子代理派发时可传）
 * @returns 综合判定：complex 分 > simple 分 → complex；反之 simple；均势 → medium
 */
export function assessComplexity(taskDesc: string, ctx?: { toolCount?: number }): Complexity {
  const lower = taskDesc.toLowerCase();
  let complexScore = 0;
  let simpleScore = 0;

  for (const k of COMPLEX_KEYWORDS) if (lower.includes(k.toLowerCase())) complexScore++;
  for (const k of SIMPLE_KEYWORDS) if (lower.includes(k.toLowerCase())) simpleScore++;

  // 长度信号：长描述（>50 token ≈ >100 字符）倾向 complex。
  // 短描述不加 simple 偏置——短任务未必简单（如「重构认证模块」虽短但是 complex），关键词更可靠。
  const tokenEst = taskDesc.length / 2;
  if (tokenEst > LONG_TOKEN_THRESHOLD) complexScore++;

  // 改动范围信号：多文件/多函数/多服务/全部 → complex。
  if (/多文件|多函数|多服务|全部|all files|multiple files/.test(taskDesc)) complexScore++;

  // 工具数信号：预估调用多工具 → complex（多步协作）。
  if (ctx?.toolCount && ctx.toolCount >= HIGH_TOOL_COUNT) complexScore++;

  if (complexScore > simpleScore) return 'complex';
  if (simpleScore > complexScore) return 'simple';
  return 'medium';
}
