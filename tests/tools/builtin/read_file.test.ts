import { describe, it, expect, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readFileTool } from '../../../src/tools/builtin/read_file.js'
import type { ToolContext } from '../../../src/tools/interface.js'

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-rf-sens-'))
const ac = () => new AbortController().signal

const ctx = (confirmSensitive?: ToolContext['confirmSensitive']): ToolContext => ({
  cwd,
  signal: ac(),
  ...(confirmSensitive !== undefined ? { confirmSensitive } : {}),
})

describe('read_file 敏感路径门（密钥外传链封堵，fail-closed）', () => {
  it('.env 路径 + 无 confirmSensitive → is_error 文案含 fail-closed（密钥不进返回值）', async () => {
    const envPath = path.join(cwd, '.env')
    fs.writeFileSync(envPath, 'API_KEY=super-secret-value')
    const res = await readFileTool.execute({ path: envPath }, ctx())
    expect(res.is_error).toBe(true)
    expect(res.content).toContain('fail-closed')
    expect(res.content).toContain('.env')
    expect(res.content).not.toContain('super-secret-value') // 密钥绝不被读进上下文
  })

  it('.env.local 同样命中（.env.* 前缀）', async () => {
    const res = await readFileTool.execute({ path: path.join(cwd, '.env.local') }, ctx())
    expect(res.is_error).toBe(true)
    expect(res.content).toContain('fail-closed')
  })

  it('~/.ecode/config.json（目录围栏）无 confirmSensitive → fail-closed（不触盘即拦截）', async () => {
    // 判定在 fs 读取之前：无需真实文件存在，也不会读到用户真实 apiKey
    const res = await readFileTool.execute({ path: path.join(os.homedir(), '.ecode', 'config.json') }, ctx())
    expect(res.is_error).toBe(true)
    expect(res.content).toContain('fail-closed')
  })

  it('~/.ssh/id_ed25519（目录围栏 + basename）→ fail-closed', async () => {
    const res = await readFileTool.execute({ path: path.join(os.homedir(), '.ssh', 'id_ed25519') }, ctx())
    expect(res.is_error).toBe(true)
    expect(res.content).toContain('fail-closed')
  })

  it('id_rsa* / *.pem basename 命中（任意目录）→ fail-closed', async () => {
    const rsa = await readFileTool.execute({ path: path.join(cwd, 'id_rsa') }, ctx())
    expect(rsa.is_error).toBe(true)
    const pem = await readFileTool.execute({ path: path.join(cwd, 'server.pem') }, ctx())
    expect(pem.is_error).toBe(true)
    expect(pem.content).toContain('fail-closed')
  })

  it('复审补充清单：.netrc/.npmrc/secrets.yml/credentials → fail-closed', async () => {
    for (const name of ['.netrc', '.npmrc', 'secrets.yml', 'credentials']) {
      const res = await readFileTool.execute({ path: path.join(cwd, name) }, ctx())
      expect(res.is_error, name).toBe(true)
      expect(res.content).toContain('fail-closed')
    }
    const aws = await readFileTool.execute(
      { path: path.join(os.homedir(), '.aws', 'credentials') },
      ctx(),
    )
    expect(aws.is_error).toBe(true) // ~/.aws 目录围栏
  })

  it('confirmSensitive 返回 true → 正常读取（用户已确认）', async () => {
    const envPath = path.join(cwd, '.env.confirmed')
    fs.writeFileSync(envPath, 'X=1')
    const confirmSensitive = vi.fn(async () => true)
    const res = await readFileTool.execute({ path: envPath }, ctx(confirmSensitive))
    expect(confirmSensitive).toHaveBeenCalledTimes(1)
    expect(confirmSensitive.mock.calls[0]?.[0]).toContain('.env.confirmed') // 描述含路径
    expect(res.is_error).toBeFalsy()
    expect(res.content).toBe('X=1')
  })

  it('confirmSensitive 返回 false → is_error 拒绝（用户拒绝）', async () => {
    const envPath = path.join(cwd, '.env.denied')
    fs.writeFileSync(envPath, 'SECRET=nope')
    const res = await readFileTool.execute({ path: envPath }, ctx(async () => false))
    expect(res.is_error).toBe(true)
    expect(res.content).toContain('拒绝')
    expect(res.content).not.toContain('nope')
  })

  it('普通源码文件零行为变化（不受敏感门影响）', async () => {
    const src = path.join(cwd, 'app.ts')
    fs.writeFileSync(src, 'export const x = 1')
    const res = await readFileTool.execute({ path: src }, ctx())
    expect(res.is_error).toBeFalsy()
    expect(res.content).toBe('export const x = 1')
  })

  it('复审补口：symlink/junction 穿透——经链接读敏感文件同样 fail-closed（词法+真实路径双判）', async () => {
    // 围栏是「真实 homedir 下的 .ecode」——在真实 ~/.ecode 放无害占位文件（内容自控，
    // 断言失败也不泄真密钥），经项目内 junction 读它：词法路径在 proj 下不命中，realpath 解回围栏内必拦
    const probe = path.join(os.homedir(), '.ecode', 'ecode-sens-selftest.tmp')
    fs.writeFileSync(probe, 'sk-selftest-placeholder')
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-sens-proj-'))
    const link = path.join(proj, 'link')
    try {
      fs.symlinkSync(path.join(os.homedir(), '.ecode'), link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      fs.rmSync(probe, { force: true })
      console.warn('symlink 无权限环境，跳过断言')
      return
    }
    try {
      const res = await readFileTool.execute({ path: path.join(link, 'ecode-sens-selftest.tmp') }, ctx())
      expect(res.is_error).toBe(true)
      expect(res.content).toContain('fail-closed')
      expect(res.content).not.toContain('sk-selftest-placeholder')
    } finally {
      fs.rmSync(probe, { force: true })
    }
  })

  it('非敏感目录里的 pem 近似名不误伤（.peml / readme.pem.txt）', async () => {
    // .pem 是后缀匹配：.peml 不以 .pem 结尾；readme.pem.txt 以 .txt 结尾——均不命中
    fs.writeFileSync(path.join(cwd, 'notes.peml'), 'plain')
    fs.writeFileSync(path.join(cwd, 'readme.pem.txt'), 'plain2')
    const a = await readFileTool.execute({ path: path.join(cwd, 'notes.peml') }, ctx())
    expect(a.is_error).toBeFalsy()
    const b = await readFileTool.execute({ path: path.join(cwd, 'readme.pem.txt') }, ctx())
    expect(b.is_error).toBeFalsy()
  })

  // 基础读写用例（合并自旧位置 tests/tools/read_file.test.ts，对齐 tests/ 镜像 src/ 结构）
  it('读存在的文件 → content；读不存在 → is_error', async () => {
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'hello world')
    const ok = await readFileTool.execute({ path: 'a.txt' }, ctx())
    expect(ok.is_error).toBeFalsy()
    expect(ok.content).toBe('hello world')
    const miss = await readFileTool.execute({ path: 'nope.txt' }, ctx())
    expect(miss.is_error).toBe(true)
  })

  it('相对 cwd 解析子目录；绝对路径也能读', async () => {
    fs.mkdirSync(path.join(cwd, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'sub', 'b.txt'), 'sub content')
    const rel = await readFileTool.execute({ path: 'sub/b.txt' }, ctx())
    expect(rel.content).toBe('sub content')
    const abs = await readFileTool.execute({ path: path.join(cwd, 'sub', 'b.txt') }, ctx())
    expect(abs.content).toBe('sub content')
  })
})

describe('read_file 图片恒直传（2026-08-29 拆视觉名门）', () => {
  /** 最小合法 PNG（8 字节签名 + IHDR：1×1，CRC 空占位——判定只看头段） */
  const minPng = (): Buffer => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const len = Buffer.from([0, 0, 0, 13])
    const ihdr = Buffer.from('IHDR')
    const data = Buffer.alloc(13)
    data.writeUInt32BE(1, 0)
    data.writeUInt32BE(1, 4)
    data[8] = 8
    data[9] = 2
    return Buffer.concat([sig, len, ihdr, data, Buffer.alloc(4)])
  }

  it('非视觉系模型名（glm-5.3）读图仍返回 ImageBlock——能力由端点自证，不做名字前置拦截', async () => {
    const img = path.join(cwd, 'pic.png')
    fs.writeFileSync(img, minPng())
    const res = await readFileTool.execute({ path: img }, { ...ctx(), model: 'glm-5.3' })
    expect(res.is_error).toBeFalsy()
    expect(res.content).toContain('已读取图片')
    expect(res.blocks?.[0]?.type).toBe('image')
  })
})
