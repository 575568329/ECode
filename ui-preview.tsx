import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';

// ============================================================
// ECode REPL UI 预览 —— 交互式轮播 10 个关键界面
// 跑：npx tsx ui-preview.tsx
// 操作：← / → 或空格 切换场景 · q / esc 退出
// ============================================================

// ---------- 配色 token（17 个，Catppuccin Mocha 基底）----------
const T = {
  brand: '#4ECDC4',
  user: '#89B4FA',
  tool: '#F9E2AF',
  result: '#6C7086',
  success: '#A6E3A1',
  error: '#F38BA8',
  warning: '#FAB387',
  info: '#89B4FA',
  permission: '#FAB387',
  thinking: '#94E2D5',
  suggestion: '#7F849C',
  accent: '#89B4FA',
  muted: '#6C7086',
  border: '#45475A',
  diffAdded: '#A6E3A1',
  diffRemoved: '#F38BA8',
} as const;

// ---------- 缩进消息块（替代手动敲空格，Ink 里 paddingLeft 可靠）----------
const Msg: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Box flexDirection="column" paddingLeft={4}>
    {children}
  </Box>
);

// ---------- Spinner（braille 动画）----------
const Spinner: React.FC<{ color?: string }> = ({ color = T.brand }) => {
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((v) => (v + 1) % frames.length), 80);
    return () => clearInterval(id);
  }, []);
  return <Text color={color}>{frames[i]}</Text>;
};

// ---------- Logo（5 行方块 E + ▶_）----------
const Logo: React.FC = () => (
  <Box flexDirection="column">
    <Text color={T.brand}>███████</Text>
    <Text color={T.brand}>█</Text>
    <Text>
      <Text color={T.brand}>█████   </Text>
      <Text color={T.accent}>▶</Text>
      <Text color={T.muted}>_</Text>
    </Text>
    <Text color={T.brand}>█</Text>
    <Text color={T.brand}>███████</Text>
  </Box>
);

// ---------- 输入提示符（正在输入态，亮蓝）----------
const Prompt: React.FC = () => (
  <Text>
    <Text color={T.user}>❯ </Text>
    <Text color={T.muted}>_</Text>
  </Text>
);

// ============================================================
// 场景 1：欢迎界面
// ============================================================
const WelcomeScreen: React.FC = () => (
  <Box flexDirection="column">
    <Text color={T.brand} bold>  ─── ECode v0.4.0 ───</Text>
    <Box flexDirection="row" gap={6} borderStyle="round" borderColor={T.border} paddingX={2} paddingY={1}>
      <Box flexDirection="column" width={34}>
        <Logo />
        <Text> </Text>
        <Text color={T.brand} bold>Welcome!</Text>
        <Text> </Text>
        <Text><Text color={T.success}>✓</Text> Loaded CLAUDE.md (project, 142 lines)</Text>
        <Text><Text color={T.success}>✓</Text> deepseek-v3 @ deepseek (connected)</Text>
        <Text><Text color={T.muted}>cwd </Text>~/projects/my-app (git)</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Text color={T.brand} bold>Commands</Text>
        <Text color={T.border}>───────────</Text>
        <Text><Text color={T.user}>/help</Text>    命令帮助</Text>
        <Text><Text color={T.user}>/model</Text>   切换模型</Text>
        <Text><Text color={T.user}>/clear</Text>   清空对话</Text>
        <Text> </Text>
        <Text color={T.brand} bold>Shortcuts</Text>
        <Text color={T.border}>───────────</Text>
        <Text><Text color={T.user}>esc</Text>      中断</Text>
        <Text><Text color={T.user}>ctrl+c×2</Text> 退出</Text>
        <Text><Text color={T.user}>↑↓</Text>       历史翻阅</Text>
      </Box>
    </Box>
    <Text> </Text>
    <Text color={T.muted}>  esc 中断 · ctrl+c×2 退出 · /help 查看命令</Text>
    <Text> </Text>
    <Prompt />
  </Box>
);

// ============================================================
// 场景 2：对话（文本回答 + 工具调用 + 结果）
// ============================================================
const ChatScene: React.FC = () => (
  <Box flexDirection="column">
    <Text><Text color={T.user} bold>❯ 你</Text></Text>
    <Msg>
      <Text color={T.muted}>帮我实现 user 登录功能</Text>
    </Msg>
    <Text> </Text>
    <Text><Text color={T.brand} bold>◆ ECode</Text></Text>
    <Msg>
      <Text>好的，让我先看看项目结构。</Text>
      <Text> </Text>
      <Text color={T.tool}>▸ Read(package.json)</Text>
      <Text color={T.result}>↳ Read 42 lines</Text>
      <Text> </Text>
      <Text color={T.tool}>▸ Bash(npm test -- --grep "auth")</Text>
      <Text color={T.result}>↳ <Text color={T.success}>✓</Text> All 12 tests passed (3.2s)</Text>
      <Text> </Text>
      <Text>我看到项目使用 Express + JWT，现在开始实现：</Text>
      <Text><Text color={T.user}>1.</Text> 添加 POST /api/auth/login 路由</Text>
      <Text><Text color={T.user}>2.</Text> 实现 JWT 签发和验证</Text>
    </Msg>
    <Text> </Text>
    <Prompt />
  </Box>
);

// ============================================================
// 场景 3：工具执行中（spinner + 计时）
// ============================================================
const ToolRunningScene: React.FC = () => (
  <Box flexDirection="column">
    <Text><Text color={T.brand} bold>◆ ECode</Text></Text>
    <Msg>
      <Text>让我运行测试看看结果...</Text>
      <Text> </Text>
      <Box>
        <Spinner color={T.brand} />
        <Text color={T.tool}> Bash(npm test)</Text>
        <Box flexGrow={1} />
        <Text color={T.muted}>3.2s</Text>
      </Box>
    </Msg>
    <Text> </Text>
    <Prompt />
  </Box>
);

// ============================================================
// 场景 4：工具完成 + diff（edit_file 完整显示，不折叠）
// ============================================================
const DiffScene: React.FC = () => (
  <Box flexDirection="column">
    <Text><Text color={T.brand} bold>◆ ECode</Text></Text>
    <Msg>
      <Text>我来修改登录逻辑：</Text>
      <Text> </Text>
      <Text color={T.tool}>▸ Edit(src/auth/login.ts)</Text>
      <Text color={T.result}>↳ <Text color={T.success}>✓</Text> Edited src/auth/login.ts (1.2s)</Text>
      <Text> </Text>
      <Box flexDirection="column">
        <Text><Text color={T.muted}>  4   </Text>{"const router = express.Router();"}</Text>
        <Text><Text color={T.muted}>  5   </Text></Text>
        <Text><Text color={T.muted}>  6   </Text>{"router.post('/login', async (req, res) => {"}</Text>
        <Text><Text color={T.muted}>  7 </Text><Text color={T.diffRemoved}>{"-   const { username } = req.body;"}</Text></Text>
        <Text><Text color={T.muted}>  7 </Text><Text color={T.diffAdded}>{"+   const { username, password } = req.body;"}</Text></Text>
        <Text><Text color={T.muted}>  8   </Text></Text>
        <Text><Text color={T.muted}>  9   </Text>{"const user = await User.findByUsername(username);"}</Text>
      </Box>
      <Text> </Text>
      <Text>改好了，现在加了 password 校验。</Text>
    </Msg>
  </Box>
);

// ============================================================
// 场景 5：工具结果折叠（per-tool 差异化：bash/grep/read）
// ============================================================
const FoldScene: React.FC = () => (
  <Box flexDirection="column">
    <Text><Text color={T.brand} bold>◆ ECode</Text></Text>
    <Msg>
      <Text color={T.tool}>▸ Bash(npm install)</Text>
      <Text color={T.result}>↳ <Text color={T.success}>✓</Text> Done (8.4s)</Text>
      <Text color={T.muted}>    added 312 packages in 4s</Text>
      <Text color={T.muted}>    ... 12 more lines</Text>
      <Text> </Text>
      <Text color={T.tool}>▸ Grep("TODO", src/)</Text>
      <Text color={T.result}>↳ <Text color={T.success}>✓</Text> 5 matches (0.3s)</Text>
      <Text>    <Text color={T.warning}>src/auth/login.ts:14</Text>  // TODO: validate password</Text>
      <Text>    <Text color={T.warning}>src/auth/login.ts:28</Text>  // TODO: rate limit</Text>
      <Text>    <Text color={T.warning}>src/utils/jwt.ts:9</Text>    // TODO: expiry config</Text>
      <Text color={T.muted}>    ... 2 more matches</Text>
      <Text> </Text>
      <Text color={T.tool}>▸ Read(src/config.ts)</Text>
      <Text color={T.result}>↳ <Text color={T.success}>✓</Text> Read 156 lines</Text>
    </Msg>
  </Box>
);

// ============================================================
// 场景 6：权限弹窗（PermissionDialog，替换 InputBar）
// ============================================================
const PermissionScene: React.FC = () => (
  <Box flexDirection="column">
    <Text><Text color={T.brand} bold>◆ ECode</Text></Text>
    <Msg>
      <Text>我需要执行这个命令：</Text>
      <Text> </Text>
      <Text color={T.tool}>▸ Bash(rm -rf node_modules)</Text>
    </Msg>
    <Text> </Text>
    <Box flexDirection="column" borderStyle="round" borderColor={T.permission} paddingX={2} paddingY={1}>
      <Text color={T.warning} bold>Permission Required</Text>
      <Text> </Text>
      <Text>Bash wants to execute:</Text>
      <Text> </Text>
      <Box paddingLeft={2}><Text color={T.tool}>rm -rf node_modules</Text></Box>
      <Text> </Text>
      <Text><Text color={T.accent}>❯ </Text><Text bold>1. Yes</Text></Text>
      <Text><Text color={T.muted}>  </Text> 2. Yes, and don't ask again this session</Text>
      <Text><Text color={T.muted}>  </Text> 3. No</Text>
      <Text> </Text>
      <Text color={T.muted}>↑↓ select · enter confirm · esc deny</Text>
    </Box>
  </Box>
);

// ============================================================
// 场景 7：thinking 推理块（左边框 + italic）
// ============================================================
const ThinkingScene: React.FC = () => (
  <Box flexDirection="column">
    <Text><Text color={T.brand} bold>◆ ECode</Text></Text>
    <Msg>
      <Box>
        <Text color={T.thinking}>◐ thinking...</Text>
        <Box flexGrow={1} />
        <Text color={T.muted}>2.1s</Text>
      </Box>
      <Text> </Text>
      <Box flexDirection="row">
        <Text color={T.thinking}>│</Text>
        <Box flexDirection="column" paddingLeft={1}>
          <Text color={T.thinking} italic>用户要实现登录功能，我需要先确认...</Text>
          <Text color={T.thinking} italic>项目用 Express，应该用 JWT 方案...</Text>
        </Box>
      </Box>
      <Text> </Text>
      <Text>好的，我的方案是...</Text>
    </Msg>
  </Box>
);

// ---------- 状态栏单行（复用）----------
const StatusBar: React.FC<{ ctxColor?: string; ctx: string; last: string; lastColor?: string }> = ({
  ctxColor = T.muted,
  ctx,
  last,
  lastColor = T.muted,
}) => (
  <Box>
    <Text color={T.muted}>⏱ 02:35</Text>
    <Text>  </Text>
    <Text color={T.info}>↑12.5K</Text>
    <Text color={T.muted}> ↓3.2K tok</Text>
    <Text>  </Text>
    <Text color={T.success}>$0.04</Text>
    <Text>  </Text>
    <Text color={ctxColor}>Ctx {ctx}%</Text>
    <Text>  </Text>
    <Text color={T.muted}>deepseek-v3 @ deepseek</Text>
    <Box flexGrow={1} />
    <Text color={lastColor}>{last}</Text>
  </Box>
);

// ============================================================
// 场景 8：状态栏（4 种状态）
// ============================================================
const StatusBarScene: React.FC = () => (
  <Box flexDirection="column">
    <Text color={T.brand} bold>状态栏 4 种状态（单行贴底）</Text>
    <Text> </Text>
    <Text color={T.muted}>① idle（等待输入）</Text>
    <StatusBar ctx="45" last="/help for commands" />
    <Text> </Text>
    <Text color={T.muted}>② streaming（LLM 输出中）</Text>
    <StatusBar ctx="45" last="esc to interrupt" lastColor={T.warning} />
    <Text> </Text>
    <Text color={T.muted}>{"③ 上下文告警（Ctx >80%）"}</Text>
    <StatusBar ctxColor={T.warning} ctx="85" last="esc to interrupt" lastColor={T.warning} />
    <Text> </Text>
    <Text color={T.muted}>④ 双击 Ctrl+C 窗口期（2000ms）</Text>
    <StatusBar ctxColor={T.error} ctx="95" last="press ctrl+c again to exit" lastColor={T.warning} />
  </Box>
);

// ============================================================
// 场景 9：警告 / 错误消息
// ============================================================
const WarnErrorScene: React.FC = () => (
  <Box flexDirection="column">
    <Text color={T.brand} bold>系统消息</Text>
    <Text> </Text>
    <Text color={T.warning}>▲ 上下文已压缩</Text>
    <Text> </Text>
    <Text color={T.error}>✗ API 调用失败: rate limit exceeded (retrying in 3s...)</Text>
    <Text> </Text>
    <Text color={T.warning}>▲ 检测到连续重复的工具调用，终止以防死循环</Text>
  </Box>
);

// ============================================================
// 场景 10：窄终端降级（宽度 < 60 列）
// ============================================================
const NarrowScene: React.FC = () => (
  <Box flexDirection="column" width={50}>
    <Text color={T.brand} bold>窄终端降级（模拟 50 列）</Text>
    <Text> </Text>
    <Text color={T.brand} bold>─── ECode v0.4.0 ───</Text>
    <Box flexDirection="row" borderStyle="round" borderColor={T.border} paddingX={1} paddingY={1}>
      <Box flexDirection="column">
        <Logo />
        <Text> </Text>
        <Text color={T.brand} bold>Welcome!</Text>
        <Text><Text color={T.success}>✓</Text> CLAUDE.md loaded</Text>
        <Text><Text color={T.success}>✓</Text> deepseek-v3 @ deepseek</Text>
      </Box>
    </Box>
    <Text> </Text>
    <Box>
      <Text color={T.muted}>⏱ 02:35</Text>
      <Text>  </Text>
      <Text color={T.success}>$0.04</Text>
      <Text>  </Text>
      <Text color={T.muted}>Ctx 45%</Text>
      <Box flexGrow={1} />
      <Text color={T.muted}>deepseek-v3</Text>
    </Box>
  </Box>
);

// ============================================================
// 轮播主组件
// ============================================================
const scenes: { title: string; Component: React.FC }[] = [
  { title: '欢迎界面', Component: WelcomeScreen },
  { title: '对话（文本+工具）', Component: ChatScene },
  { title: '工具执行中（spinner）', Component: ToolRunningScene },
  { title: '工具完成 + diff', Component: DiffScene },
  { title: '工具结果折叠（per-tool）', Component: FoldScene },
  { title: '权限弹窗', Component: PermissionScene },
  { title: 'thinking 推理块', Component: ThinkingScene },
  { title: '状态栏（4 态）', Component: StatusBarScene },
  { title: '警告 / 错误', Component: WarnErrorScene },
  { title: '窄终端降级', Component: NarrowScene },
];

const Preview: React.FC = () => {
  const [idx, setIdx] = useState(0);
  const { exit } = useApp();
  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit();
      return;
    }
    if (key.leftArrow) setIdx((i) => Math.max(0, i - 1));
    if (key.rightArrow || input === ' ') setIdx((i) => Math.min(scenes.length - 1, i + 1));
  });
  const Scene = scenes[idx].Component;
  return (
    <Box flexDirection="column" paddingBottom={1}>
      <Box marginBottom={1}>
        <Text color={T.brand} bold>ECode UI Preview</Text>
        <Text color={T.muted}> · {idx + 1}/{scenes.length} · {scenes[idx].title}</Text>
      </Box>
      <Scene />
      <Box marginTop={2}>
        <Text color={T.muted}>← → 切换 · 空格下一个 · q/esc 退出</Text>
      </Box>
    </Box>
  );
};

render(<Preview />);
