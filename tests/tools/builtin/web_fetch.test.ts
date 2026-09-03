import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebFetchTool, isPrivateIp, htmlToText, truncateMiddle, normalizeHostname, setWebFetchLimits, type FetchLike } from '../../../src/tools/builtin/web_fetch.js'

// DNS 模块级 mock（ESM 导出只读，赋值法不可用；*.example.com 公网 IP，其余私网——SSRF 用例复用）
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => {
    const isPublic = hostname === 'example.com' || hostname.endsWith('.example.com')
    return [{ address: isPublic ? '93.184.216.34' : '10.0.0.5', family: 4 }]
  }),
}))

const ctx = { cwd: '.', signal: new AbortController().signal }

function res(status: number, body: string, headers: Record<string, string> = {}): Parameters<FetchLike>[1] extends never ? never : {
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
} {
  return {
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => body,
  }
}

describe('isPrivateIp（SSRF 核心判定）', () => {
  it('私网/回环/链路本地/组播拒绝', () => {
    for (const ip of ['10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255', '127.0.0.1', '169.254.1.1', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true)
    }
  })
  it('公网地址放行', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '2606:4700::1']) {
      expect(isPrivateIp(ip), ip).toBe(false)
    }
  })
  it('安全审阅 P1-a：CGNAT 100.64.0.0/10 拒绝（含云 metadata 100.100.100.200），段外放行', () => {
    for (const ip of ['100.64.0.1', '100.100.100.200', '100.127.255.255']) {
      expect(isPrivateIp(ip), ip).toBe(true)
    }
    for (const ip of ['100.63.0.1', '100.128.0.1', '100.1.2.3']) {
      expect(isPrivateIp(ip), ip).toBe(false)
    }
  })
})

describe('htmlToText', () => {
  it('剥 script/style/nav，保留正文与代码', () => {
    const html = `<html><head><title>T</title><style>.a{}</style><script>alert(1)</script></head>
<body><nav>menu menu</nav><h1>标题</h1><p>正文段落</p><pre><code>const a = 1</code></pre></body></html>`
    const text = htmlToText(html)
    expect(text).toContain('标题')
    expect(text).toContain('正文段落')
    expect(text).toContain('const a = 1')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('.a{}')
    expect(text).not.toContain('menu')
  })
  it('实体解码 + 列表符号', () => {
    expect(htmlToText('<ul><li>a &amp; b</li><li>c</li></ul>')).toContain('• a & b')
  })
})

describe('truncateMiddle', () => {
  it('未超限原样', () => {
    expect(truncateMiddle('short').truncated).toBe(false)
  })
  it('超限头尾保留中截', () => {
    const big = 'x'.repeat(40 * 1024)
    const { text, truncated } = truncateMiddle(big)
    expect(truncated).toBe(true)
    expect(text).toContain('已截断')
    expect(text.startsWith('x')).toBe(true)
    expect(text.endsWith('x')).toBe(true)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(40 * 1024)
  })
})

describe('web_fetch execute（mock fetch + mock DNS）', () => {

  it('SSRF：localhost/私网 IP 直接拒绝（不发起请求）', async () => {
    const tool = createWebFetchTool((async () => { throw new Error('不应发起请求') }) as FetchLike)
    const r1 = await tool.execute({ url: 'http://localhost/secret' }, ctx)
    expect(r1.is_error).toBe(true)
    expect(r1.content).toContain('内网地址禁止抓取')
    const r2 = await tool.execute({ url: 'http://192.168.1.1/admin' }, ctx)
    expect(r2.content).toContain('内网地址禁止抓取')
  })

  it('SSRF：域名解析到私网拒绝（非白名单域名 mock 到 10.0.0.5）', async () => {
    const tool = createWebFetchTool((async () => res(200, 'ok')) as unknown as FetchLike)
    const r = await tool.execute({ url: 'http://evil.internal-host.com/x' }, ctx)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('解析到内网地址')
  })

  it('正常抓取：HTML 转文本 + URL 头', async () => {
    const tool = createWebFetchTool((async () =>
      res(200, '<html><body><h1>Docs</h1><p>API usage</p></body></html>', { 'content-type': 'text/html' })) as unknown as FetchLike)
    const r = await tool.execute({ url: 'https://example.com/docs' }, ctx)
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain('<fetched_web_content source="https://example.com/docs">')
    expect(r.content).toContain('Docs')
    expect(r.content).toContain('API usage')
  })

  it('重定向跟随 ≤3 跳 + 逐跳复检（跳到内网被拒）', async () => {
    const tool = createWebFetchTool((async (url: string) => {
      if (url.startsWith('https://a.example.com')) return res(302, '', { location: 'http://192.168.0.9/x' })
      throw new Error('unreachable ' + url)
    }) as unknown as FetchLike)
    const r = await tool.execute({ url: 'https://a.example.com/start' }, ctx)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('内网地址禁止抓取')
  })

  it('重定向超 3 跳 → is_error', async () => {
    let n = 0
    const tool = createWebFetchTool((async (url: string) => {
      void url
      n += 1
      return res(302, '', { location: `https://example.com/r${n}` })
    }) as unknown as FetchLike)
    const r = await tool.execute({ url: 'https://example.com/r0' }, ctx)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('重定向超限')
  })

  it('安全审阅 P1-b：重定向 Location: file:// → 每跳协议断言拒绝（不发起后续请求）', async () => {
    const tool = createWebFetchTool((async (url: string) => {
      if (url === 'https://example.com/redir') return res(302, '', { location: 'file:///etc/passwd' })
      throw new Error('不应请求非 http 目标：' + url)
    }) as unknown as FetchLike)
    const r = await tool.execute({ url: 'https://example.com/redir' }, ctx)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('非 http/https 协议')
  })

  it('HTTP 404 → is_error 带状态码', async () => {
    const tool = createWebFetchTool((async () => res(404, 'nope')) as unknown as FetchLike)
    const r = await tool.execute({ url: 'https://example.com/missing' }, ctx)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('404')
  })

  it('非 http 协议 / 非法 URL → is_error', async () => {
    const tool = createWebFetchTool((async () => res(200, '')) as unknown as FetchLike)
    expect((await tool.execute({ url: 'ftp://x' }, ctx)).is_error).toBe(true)
    expect((await tool.execute({ url: 'not a url' }, ctx)).is_error).toBe(true)
  })
})

describe('审阅修复：IPv6 归一化（P1-1/P1-3）', () => {
  it('mapped 十六进制形态私网拒绝（含 IMDS 169.254.169.254）', () => {
    expect(isPrivateIp('::ffff:ac10:101')).toBe(true) // 172.16.1.1
    expect(isPrivateIp('::ffff:a9fe:a9fe')).toBe(true) // 169.254.169.254（云元数据端点）
    expect(isPrivateIp('::ffff:7f00:1')).toBe(true) // 127.0.0.1
    expect(isPrivateIp('64:ff9b::7f00:1')).toBe(true) // NAT64 内嵌回环
  })
  it('mapped 公网地址放行', () => {
    expect(isPrivateIp('::ffff:808:808')).toBe(false) // 8.8.8.8
    expect(isPrivateIp('2606:4700::1')).toBe(false)
  })
  it('normalizeHostname 剥 IPv6 方括号', () => {
    expect(normalizeHostname('[::ffff:ac10:101]')).toBe('::ffff:ac10:101')
    expect(normalizeHostname('example.com')).toBe('example.com')
  })
})

describe('截断上限可配（setWebFetchLimits）', () => {
  afterEach(() => {
    setWebFetchLimits({ maxContentKB: 30 }) // 恢复默认（断言失败也复位——全局状态不泄漏污染后续用例）
  })

  it('调小上限后更早截断', async () => {
    setWebFetchLimits({ maxContentKB: 1 }) // 1KB
    const big = 'z'.repeat(3 * 1024)
    const tool = createWebFetchTool((async () => res(200, big, { 'content-type': 'text/plain' })) as unknown as FetchLike)
    const r = await tool.execute({ url: 'https://example.com/big' }, ctx)
    expect(r.content).toContain('truncated="true"')
    expect((r.content ?? '').length).toBeLessThan(3 * 1024)
    setWebFetchLimits({ maxContentKB: 30 })
    const r2 = await tool.execute({ url: 'https://example.com/big' }, ctx)
    expect(r2.content).not.toContain('truncated="true"')
  })

  it('body 硬顶：字节数判定（中文页字符数低估 3 倍——审阅 P1-3）超 512KB 放弃', async () => {
    const huge = '字'.repeat(200 * 1024) // 600KB 字节（200K 字符——旧 length 判定不触发）
    const tool = createWebFetchTool((async () => res(200, huge, { 'content-type': 'text/plain' })) as unknown as FetchLike)
    const r = await tool.execute({ url: 'https://example.com/huge' }, ctx)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('硬顶')
  })

  it('二轮审阅：body 流式截断——超限时 cancel 流且不读完全部 chunk（内存 DoS 面）', async () => {
    let cancelled = false
    let reads = 0
    // 3 个 200KB chunk（共 600KB > 512KB 硬顶）——旧实现 text() 全读后才弃；流式应在第 3 块 cancel
    const chunk = new Uint8Array(200 * 1024).fill(0x61)
    const stream = {
      getReader() {
        let i = 0
        return {
          read: async () => {
            reads += 1
            if (i < 3) {
              i += 1
              return { done: false, value: chunk }
            }
            return { done: true }
          },
          cancel: async () => {
            cancelled = true
          },
        }
      },
    }
    const tool = createWebFetchTool(
      (async () => ({ status: 200, headers: { get: () => 'text/plain' }, text: async () => { throw new Error('不应走 text() 全读') }, body: stream })) as unknown as FetchLike,
    )
    const r = await tool.execute({ url: 'https://example.com/stream-huge' }, ctx)
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('硬顶')
    expect(cancelled).toBe(true) // 流被显式 cancel——服务端无法继续推流
    expect(reads).toBeLessThanOrEqual(3) // 未读第 4 次（done 探测也不发生——超限即断）
  })

  it('二轮审阅：body 流式在限内——多 chunk 合并解码正确（UTF-8 跨 chunk 边界）', async () => {
    // '字' 的 UTF-8 是 3 字节——拆成 [前 2 字节 | 后 1 字节 + 其余] 两 chunk，合并解码须还原
    const text = '字'.repeat(10)
    const bytes = new TextEncoder().encode(text)
    const stream = {
      getReader() {
        let i = 0
        return {
          read: async () => {
            if (i === 0) {
              i += 1
              return { done: false, value: bytes.slice(0, 5) } // 切在多字节序列中间
            }
            if (i === 1) {
              i += 1
              return { done: false, value: bytes.slice(5) }
            }
            return { done: true }
          },
          cancel: async () => {},
        }
      },
    }
    const tool = createWebFetchTool(
      (async () => ({ status: 200, headers: { get: () => 'text/plain' }, text: async () => { throw new Error('不应走 text()') }, body: stream })) as unknown as FetchLike,
    )
    const r = await tool.execute({ url: 'https://example.com/stream-ok' }, ctx)
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain(text)
  })
})
