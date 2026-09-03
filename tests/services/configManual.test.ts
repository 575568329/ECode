/**
 * 防漂移方案（2026-09-03）§4.1 方案 A + §4.2 方案 B：活文档防漂移测试。
 *
 * 锁四条同步关系（漂移当天即红）：
 *  A1 手册含键：Config/ProviderCfg 接口字段 ⊆ ECODE_CONFIG_BODY 文本（宽松含词——只漏报不误报）
 *  A2 模板含键：CONFIG_TEMPLATE 文本 ⊇ Config 顶层字段（豁免清单显式维护带注释）
 *  B1 模板→手册：CONFIG_TEMPLATE 的引号键逐个在手册正文出现（宽松含词）——防「模板加了手册没加」
 *  B2 手册→模板：手册 jsonc 示例块引号键 ⊆ CONFIG_TEMPLATE 引号键——防「手册加了模板没加」
 *
 * 误报控制：B1/B2 的域外键（示例供应商名/hook 信封/settings 权限域）走显式豁免清单并注明理由；
 * 宽松含词匹配只漏报不误报，漏报由 /doctor 抽查兜底（方案 §4.1）。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CONFIG_TEMPLATE } from '../../src/services/config.js'
import { builtinSkillInfos } from '../../src/services/skill/builtin.js'

const configSrc = readFileSync(new URL('../../src/services/config.ts', import.meta.url), 'utf8')
const manual = builtinSkillInfos().find((s) => s.name === 'ecode-config')!.body

/** 从 config.ts 源码提取 interface 字段名（两空格缩进 + 标识符 + 可选 ? + 冒号——最稳定形态） */
function extractInterfaceFields(interfaceName: 'Config' | 'ProviderCfg'): string[] {
  const start = configSrc.indexOf(`export interface ${interfaceName} {`)
  expect(start, `config.ts 应包含 export interface ${interfaceName}`).toBeGreaterThan(-1)
  const open = configSrc.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < configSrc.length; i++) {
    if (configSrc[i] === '{') depth++
    else if (configSrc[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = configSrc.slice(open, end)
  const names: string[] = []
  // 只认「行首两空格 + 标识符(可带 ?) + 冒号」——注释里的 `xxx:` 不含此形态（缩进不定）
  for (const m of body.matchAll(/^\s{2}([A-Za-z_]\w*)\??:/gm)) names.push(m[1])
  return [...new Set(names)]
}

const configFields = extractInterfaceFields('Config')
const providerFields = extractInterfaceFields('ProviderCfg')

/**
 * 接口字段豁免（A1/A2 共用；改动时在此登记理由）。
 * 原则：运行时派生/仅内存构造、用户不在 config.json 里配的键才可豁免。
 */
const INTERFACE_EXEMPT = new Set<string>([
  'current', // 运行时派生键：loadConfig 从 default/providers 推导激活项，手册写「default 即启动选中」已覆盖语义
])

describe('防漂移 §4.1 方案 A：手册↔Config 键一致性', () => {
  it('A1: Config/ProviderCfg 全部接口字段名出现在 ecode-config 手册正文', () => {
    const missing = [...configFields, ...providerFields]
      .filter((f) => !INTERFACE_EXEMPT.has(f))
      .filter((f) => !manual.includes(f))
    // 失败信息按缺失键分组输出（红时可读性——直接知道补哪几行）
    expect(missing, `手册缺以下字段（补进 builtin.ts ECODE_CONFIG_BODY）：\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('A2: CONFIG_TEMPLATE 文本覆盖 Config 全部顶层字段（豁免清单外）', () => {
    const missing = configFields
      .filter((f) => !INTERFACE_EXEMPT.has(f))
      .filter((f) => !CONFIG_TEMPLATE.includes(f))
    expect(missing, `CONFIG_TEMPLATE 缺以下字段（补模板注释或登记豁免）：\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('提取器冒烟：知名字段必须被抓到（提取器自身回归锚——格式变化即红）', () => {
    expect(configFields).toContain('review')
    expect(configFields).toContain('feishu')
    expect(configFields).toContain('wechat')
    expect(configFields).toContain('subagentMaxIterations')
    expect(providerFields).toContain('contextWindow')
    expect(providerFields).toContain('streamStallMs')
  })
})

describe('防漂移 §4.2 方案 B：CONFIG_TEMPLATE ↔ 手册 双向对账', () => {
  /** 提取文本中 "key": 形态的引号键名 */
  function quotedKeys(text: string): Set<string> {
    return new Set([...text.matchAll(/"([A-Za-z_]\w*)":/g)].map((m) => m[1]))
  }
  const tmplKeys = quotedKeys(CONFIG_TEMPLATE)
  const manualKeys = quotedKeys(manual)

  /**
   * B1 豁免：模板里出现但不要求手册收编的键（域外内容，登记理由）。
   * 原则：**Config 真实键一律不豁免**——豁免只给示例值与外部域信封。
   */
  const B1_EXEMPT = new Set<string>([
    'astron', // 模板示例供应商名（用户自定义 key 的占位值，非配置键）
    'deepseek', // 模板多供应商示例名（同上）
    'event', // hook 信封键（M7 事件 schema 在 docs/hooks 专题；手册字段表只列事件名）
    'matcher', // 同上
    'handler', // 同上
    'kind', // 同上
  ])

  /**
   * B2 豁免：手册 jsonc 示例块里有、不要求模板收编的键（域外内容，登记理由）。
   */
  const B2_EXEMPT = new Set<string>([
    'idleTimeout', // mcp 生命周期键：模板以注释形式提及（模板示例保持最小），手册整节覆盖
    'permissions', // settings 权限域（settings.json 三层），不属于 config.json
    'allow', // 同上
    'ask', // 同上
    'deny', // 同上
    'Authorization', // http 示例 header 名（用户自定义 header 的占位）
  ])

  it('B1: 模板引号键逐个在手册正文出现（防「模板加了手册没加」半更新）', () => {
    const missing = [...tmplKeys].filter((k) => !B1_EXEMPT.has(k) && !manual.includes(k))
    expect(missing, `以下键在 CONFIG_TEMPLATE 出现但手册缺失：\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('B2: 手册 jsonc 示例键 ⊆ 模板引号键（防「手册加了模板没加」半更新）', () => {
    const missing = [...manualKeys].filter((k) => !B2_EXEMPT.has(k) && !tmplKeys.has(k))
    expect(missing, `以下键在手册出现但 CONFIG_TEMPLATE 缺失：\n  ${missing.join('\n  ')}`).toEqual([])
  })
})
