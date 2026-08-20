/** grep 敏感门（复审 P0：grep 曾旁路 read_file 的门直读密钥文件，外传链重放）。 */
import { describe, it, expect, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { grepTool } from '../../../src/tools/builtin/grep.js'
import type { ToolContext } from '../../../src/tools/interface.js'

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-grep-sens-'))
const ac = () => new AbortController().signal
const ctx = (confirmSensitive?: ToolContext['confirmSensitive']): ToolContext => ({
  cwd,
  signal: ac(),
  ...(confirmSensitive !== undefined ? { confirmSensitive } : {}),
})

describe('grep 敏感门（与 read_file 共用 tools/sensitive.ts）', () => {
  it('path=敏感文件直读 → fail-closed，密钥值不进返回值', async () => {
    const p = path.join(cwd, '.env')
    fs.writeFileSync(p, 'API_KEY=super-secret-value')
    const res = await grepTool.execute({ pattern: 'API_KEY', path: p }, ctx())
    expect(res.is_error).toBe(true)
    expect(res.content).toContain('fail-closed')
    expect(res.content).not.toContain('super-secret-value')
  })

  it('~/.ecode/config.json 直读 → fail-closed（判定在 fs 读取之前，不触盘即拦）', async () => {
    const res = await grepTool.execute(
      { pattern: 'apiKey', path: path.join(os.homedir(), '.ecode', 'config.json') },
      ctx(),
    )
    expect(res.is_error).toBe(true)
    expect(res.content).toContain('fail-closed')
  })

  it('confirmSensitive 返回 true → 放行搜索（描述含路径）', async () => {
    const p = path.join(cwd, '.env.confirmed')
    fs.writeFileSync(p, 'TOKEN=YES')
    const confirmSensitive = vi.fn(async () => true)
    const res = await grepTool.execute({ pattern: 'TOKEN', path: p }, ctx(confirmSensitive))
    expect(confirmSensitive).toHaveBeenCalledTimes(1)
    expect(confirmSensitive.mock.calls[0]?.[0]).toContain('.env.confirmed')
    expect(res.is_error).toBeFalsy()
    expect(res.content).toContain('TOKEN=YES')
  })

  it('目录游走跳过敏感文件并在尾部注明（内容不泄露）', async () => {
    fs.writeFileSync(path.join(cwd, 'app.ts'), 'const TOKEN_POS = 1')
    fs.writeFileSync(path.join(cwd, 'secrets.yml'), 'TOKEN=zzz-secret')
    const res = await grepTool.execute({ pattern: 'TOKEN' }, ctx())
    expect(res.is_error).toBeFalsy()
    expect(res.content).toContain('app.ts')
    expect(res.content).toContain('已跳过 1 个敏感文件')
    expect(res.content).not.toContain('zzz-secret')
  })

  it('普通目录搜索不受影响', async () => {
    fs.writeFileSync(path.join(cwd, 'plain.txt'), 'hello grep')
    const res = await grepTool.execute({ pattern: 'hello' }, ctx())
    expect(res.is_error).toBeFalsy()
    expect(res.content).toContain('hello grep')
  })
})
