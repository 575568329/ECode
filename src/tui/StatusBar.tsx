import type { ReactElement } from 'react'
import { Fragment } from 'react'
import { Text, Box } from 'ink'
import stringWidth from 'string-width'
import { theme } from './theme.js'
import { useViewport, clipWidth } from './viewport.js'

interface StatusBarProps {
  model: string
  iter?: number
  maxIter?: number
  tokens?: number
  /** F-44：上下文占用/模型窗口（usage 帧透出）——ctx 段显示占用与余量，≥90%（压缩阈值）warn 色 */
  ctxUsed?: number
  ctxWindow?: number
  cost?: string
  /** MCP 段（M6：'MCP 2/3' / 'MCP 连接中'——2026-09-02 精简批回调：M 单字母看不懂；undefined 不显示） */
  mcp?: string
  /** M9-P4：沙箱模式段（default 不显示；档位箭头+短词即语义，不再重复 mode 全名） */
  sandbox?: string
  /** full-access 危险色（M9-D12）；批3（P1-B/B1）：danger 态 sandbox 段恒留（pinnedKeys） */
  sandboxDanger?: boolean
  /** T5：daemon 运行段（'后台运行'/'后台连接中'/'后台重连中'——2026-09-02 精简批回调：D✓ 看不懂；undefined 不显示） */
  daemon?: string
  daemonDanger?: boolean
  /** 2026-09-02 用户点名：本进程内存占用（RSS）常驻显示——孤儿实例堆积 4.8GB 事故后的内存可见性 */
  memBytes?: number
  /** 同行尾随内容已占宽度（App 层 busy 态快捷键提示）——宽度守卫扣减，防同行 wrap 破帧账 */
  reserveWidth?: number
}

/** token 数人类可读（智能进位省宽，2026-08-29 用户点名「1000.0k 该用 1m」）：
 *  <1000 原值；k/m/g 逐级进位，一位小数、整值去 .0——45k / 999.5k / 1m / 1.2m。
 *  2026-09-02 精简批：去 " tok" 后缀（段前缀 T/ctx 已含语义） */
const TOKEN_SCALES: Array<[number, string]> = [
  [1e9, 'g'],
  [1e6, 'm'],
  [1e3, 'k'],
]
function formatTokens(n: number): string {
  for (const [scale, unit] of TOKEN_SCALES) {
    if (n >= scale) {
      const v = (n / scale).toFixed(1)
      return `${v.endsWith('.0') ? v.slice(0, -2) : v}${unit}`
    }
  }
  return `${n}`
}

/** 内存人类可读（RSS bytes）：MB 整数、GB 一位小数（≥10G 取整去小数）——R350M / R1.4G / R12G。
 *  先舍入到整数 MB 再判进位（审阅 P2-3：1023.99M 按 1024M 显示而非 1G 的口径错位） */
export function formatMem(bytes: number): string {
  const mb = Math.max(1, Math.round(bytes / 1024 ** 2))
  if (mb < 1024) return `${mb}M`
  const v = mb / 1024
  return `${v >= 10 ? Math.round(v) : Number(v.toFixed(1))}G`
}

/** C2 档位可视化（CC ⏵⏵ 式）：箭头/图标 + 短词表策略（2026-09-02 两次用户回调：
 *  「⏵⏵e 看不懂」→ 箭头配短词；「⚠⏵⏵⏵ 别人也看不懂」→ full-access 弃箭头用 ⚠ 全词） */
export function sandboxArrows(mode: string): string {
  switch (mode) {
    case 'accept-edits':
      return '⏵⏵ edits'
    case 'workspace-write':
      return '⏵⏵ write'
    case 'full-access':
      return 'full-access'
    case 'read-only':
      return '⛔ read-only'
    default:
      return ''
  }
}

/** 宽度守卫的丢弃顺序（先丢 → 后丢；model 不在列 = 恒留，超长走 clipWidth 截断）。
 *  原则：观测类（daemon/mcp/mem/cost）先于计量类（tokens/sandbox/iter），ctx 最后丢
 *  （压缩临近警告 ≥90% warn 色，是唯一带行动指引的段）。
 *  P1-B（批3，2026-09-03）：fitSegments 增 pinnedKeys 参数——危险态（sandboxDanger）把
 *  sandbox 段提为与 model 同级恒留（安全提示要确定性而非概率性保留——走完牺牲序后无
 *  非 model 段兜底截断，"挪到最后丢"在极窄下仍会被丢，full-access 不知情放行副作用工具
 *  的代价 >> 截短 model 名）。正常档维持现序。 */
const SEG_SACRIFICE_ORDER = ['daemon', 'mcp', 'mem', 'cost', 'sandbox', 'tokens', 'iter', 'ctx'] as const

/** 段分隔符——导出单源（审阅 P2-2：App 层 busy 提示分隔符与守卫宽度计算共用，防两处漂移） */
export const SEG_SEPARATOR = ' · '

interface Seg {
  key: string
  /** 纯文本形态（守卫测宽用——与 node 同源构造，防两处漂移） */
  text: string
  node: ReactElement
}

/** 宽度守卫：显示宽超 columns 时按可牺牲度丢段（2026-09-02 用户点名「避免状态太多放不下」——
 *  状态行 wrap 成两行会破坏 allocateDynamic 的帧账（StatusBar 恒 1 行），触发 win32 全清）。
 *  pinnedKeys：恒留段（不走牺牲序）——model 恒在列（历史同构）；批3 起 sandboxDanger 时
 *  追加 'sandbox'（P1-B/B1，见 SEG_SACRIFICE_ORDER 头注释）。 */
export function fitSegments<T extends { key: string; text: string }>(segments: T[], columns: number, pinnedKeys: readonly string[] = []): T[] {
  const totalWidth = (segs: T[]): number =>
    segs.reduce((acc, s, i) => acc + stringWidth(s.text) + (i > 0 ? stringWidth(SEG_SEPARATOR) : 0), 0)
  let kept = segments
  for (const key of SEG_SACRIFICE_ORDER) {
    if (totalWidth(kept) <= columns) break
    if (pinnedKeys.includes(key)) continue // 恒留段不参与牺牲
    const next = kept.filter((s) => s.key !== key)
    if (next.length === kept.length) continue // 该段不在场（可选段缺省）
    kept = next
  }
  return kept
}

/**
 * 顶栏：model / 轮数 / token / 成本（TUI 规范 §4.2/§7）。
 * 2026-09-02 精简批（用户点名）：去品牌前缀、图标/单字母化（#3/25 · T45k · M2/3 · ⏵⏵e · D✓）、
 * 新增内存段 R350M；超宽按可牺牲度丢段，model 恒留。
 * warning 不在此渲染——运行时告警由 App 层渲染为底部独立第二行（长消息截断，
 * 防止 429 等含 JSON body 的错误把本行与快捷键提示挤碎）。
 */
export function StatusBar({
  model,
  iter,
  maxIter,
  tokens,
  ctxUsed,
  ctxWindow,
  cost,
  mcp,
  sandbox,
  sandboxDanger,
  daemon,
  daemonDanger,
  memBytes,
  reserveWidth = 0,
}: StatusBarProps): ReactElement {
  const { columns } = useViewport()
  const arrows = sandbox !== undefined ? sandboxArrows(sandbox) : ''
  // F-44：ctx 段（占用/窗口，如 ctx 45k/200k）——占用取 usage 帧 API 真值（input+cacheRead）；
  // ≥90% 窗口（压缩触发阈值 0.9，compaction/strategy.ts）转 warn 色：余量将尽、下轮即压
  const ctxRatio = ctxUsed !== undefined && ctxWindow !== undefined && ctxWindow > 0 ? ctxUsed / ctxWindow : null
  const ctxHot = ctxRatio !== null && ctxRatio >= 0.9

  const segments: Seg[] = []
  segments.push({ key: 'model', text: model, node: <Text bold>{model}</Text> })
  if (iter !== undefined) {
    const t = `#${iter}${maxIter !== undefined ? `/${maxIter}` : ''}`
    segments.push({ key: 'iter', text: t, node: <Text dimColor>{t}</Text> })
  }
  if (ctxUsed !== undefined && ctxWindow !== undefined) {
    const t = `ctx ${formatTokens(ctxUsed)}/${formatTokens(ctxWindow)}`
    segments.push({
      key: 'ctx',
      text: t,
      node: (
        <Text dimColor={!ctxHot} color={ctxHot ? theme.warn : undefined} bold={ctxHot}>
          {t}
        </Text>
      ),
    })
  }
  if (tokens !== undefined) {
    const t = `T${formatTokens(tokens)}`
    segments.push({ key: 'tokens', text: t, node: <Text dimColor>{t}</Text> })
  }
  if (arrows !== '') {
    const t = `${sandboxDanger ? '⚠ ' : ''}${arrows}`
    segments.push({
      key: 'sandbox',
      text: t,
      node: sandboxDanger ? (
        <Text color={theme.error} bold>
          {t}
        </Text>
      ) : (
        <Text dimColor>{t}</Text>
      ),
    })
  }
  if (cost !== undefined) segments.push({ key: 'cost', text: cost, node: <Text dimColor>{cost}</Text> })
  if (memBytes !== undefined) {
    const t = `R${formatMem(memBytes)}`
    segments.push({ key: 'mem', text: t, node: <Text dimColor>{t}</Text> })
  }
  if (mcp !== undefined) segments.push({ key: 'mcp', text: mcp, node: <Text dimColor>{mcp}</Text> })
  if (daemon !== undefined) {
    segments.push({
      key: 'daemon',
      text: daemon,
      node: daemonDanger ? (
        <Text color={theme.warn} bold>
          {daemon}
        </Text>
      ) : (
        <Text dimColor>{daemon}</Text>
      ),
    })
  }

  // model 段恒留：超长截断无条件做（审阅 P1：旧实现只在"全段保住"分支截断——丢过段后
  // 只剩超长 model 时不截 → wrap 破「StatusBar 恒 1 行」帧账触发 win32 全清）。
  // 批3（P1-B 宽度账）：danger 态 sandbox 恒留后，model 截断预算改为 **avail 减去其余保留
  // 段与分隔符的实占**——否则 clip 到全 avail 会叠加恒留段（⚠ full-access 13+分隔符 3=16）
  // 破行。账恒成立：avail 有 Math.max(20,·) 保底 ≥ 16+4（model 恒得 ≥4 字符）；保命下限 2。
  const avail = Math.max(20, columns - reserveWidth)
  const pinned = sandboxDanger && arrows !== '' ? (['model', 'sandbox'] as const) : ['model'] as const
  const kept = fitSegments(segments, avail, pinned)
  const nonModelW = kept.reduce(
    (acc, s) => acc + (s.key === 'model' ? 0 : stringWidth(s.text) + stringWidth(SEG_SEPARATOR)),
    0,
  )
  const modelShown = clipWidth(model, Math.max(2, avail - nonModelW))
  if (modelShown !== model) {
    const idx = kept.findIndex((s) => s.key === 'model')
    if (idx >= 0) kept[idx] = { ...kept[idx], text: modelShown, node: <Text bold>{modelShown}</Text> }
  }
  return (
    <Box>
      {kept.map((s, i) => (
        <Fragment key={s.key}>
          {i > 0 && <Text dimColor>{SEG_SEPARATOR}</Text>}
          {s.node}
        </Fragment>
      ))}
    </Box>
  )
}
