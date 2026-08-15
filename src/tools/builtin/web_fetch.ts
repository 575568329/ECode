/**
 * web_fetch 工具（M8 §4，M8-D9）：抓公开网页转文本喂 LLM——查最新文档/API 的硬缺口。
 *
 * 四道关卡：① SSRF 私网拦截（DNS 解析后校验 IP；私有段/回环/链路本地/.local 拒绝，
 * 重定向逐跳复检）② GET + 15s 超时 + ≤3 跳 ③ HTML→文本（剥 script/style/nav，
 * 保留标题/正文/代码块）④ 30KB 头尾中截（复用截断惯例）。
 * readonly（只读公开网页，免确认）；M9 沙箱统一收口。
 */

import { lookup } from 'node:dns/promises'
import net from 'node:net'
import type { Tool } from '../interface.js'

const FETCH_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 3
const MAX_CONTENT_BYTES = 30 * 1024

/** 目标 IP 是否私网/保留段（SSRF 拦截核心）。 */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number)
    const [a, b] = [parts[0], parts[1]] as [number, number]
    if (a === 10 || a === 127 || a === 0) return true // 私有/回环/本网络
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true // 链路本地
    if (a >= 224) return true // 组播/保留
    return false
  }
  // IPv6：回环 / 唯一本地 / 链路本地 / IPv4-mapped
  const lower = ip.toLowerCase()
  return (
    lower === '::1' ||
    lower.startsWith('fc') || lower.startsWith('fd') ||
    lower.startsWith('fe80') ||
    lower.startsWith('::ffff:127.') || lower.startsWith('::ffff:10.') || lower.startsWith('::ffff:192.168.')
  )
}

/** 域名安全校验：解析全部 A/AAAA 记录，任一私网即拒（防 DNS rebinding 首跳过滤）。 */
export async function assertPublicHost(hostname: string): Promise<void> {
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error(`内网地址禁止抓取：${hostname}`)
  }
  if (net.isIP(hostname) !== 0) {
    if (isPrivateIp(hostname)) throw new Error(`内网地址禁止抓取：${hostname}`)
    return
  }
  const records = await lookup(hostname, { all: true })
  for (const r of records) {
    if (isPrivateIp(r.address)) throw new Error(`域名 ${hostname} 解析到内网地址 ${r.address}，禁止抓取`)
  }
}

/** HTML → 纯文本：剥 script/style/noscript/模板块，保留标题/正文/代码块/链接文本。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => l !== '' || (arr[i - 1] ?? '') !== '')
    .join('\n')
    .trim()
}

/** 30KB 头尾中截（与 bash 输出截断同惯例：防刷屏 + 防编造）。 */
export function truncateMiddle(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= MAX_CONTENT_BYTES) return { text, truncated: false }
  const buf = Buffer.from(text, 'utf8')
  const half = Math.floor(MAX_CONTENT_BYTES / 2)
  const head = buf.subarray(0, half).toString('utf8')
  const tail = buf.subarray(bytes - half).toString('utf8')
  return {
    text: `${head}\n…（中间 ${bytes - MAX_CONTENT_BYTES} 字节已截断；需要其它部分换更具体的 URL/锚点）\n${tail}`,
    truncated: true,
  }
}

/** 供测试注入的 fetch 形态。 */
export type FetchLike = (url: string, init: { redirect: 'manual'; signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>

export function createWebFetchTool(fetchImpl: FetchLike = fetch as unknown as FetchLike): Tool {
  return {
    name: 'web_fetch',
    description:
      '抓取公开网页并转为文本（查最新文档/API/资料用）。优先读本地代码与文档；线上信息不确定时才用。只支持 http/https GET；返回纯文本（超 30KB 头尾保留中截）。',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整 URL（http/https）' },
      },
      required: ['url'],
    },
    readonly: true,

    async execute(args, ctx) {
      const { url } = args as { url: string }
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return { content: `URL 非法：${url}`, is_error: true }
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { content: `仅支持 http/https（收到 ${parsed.protocol}）`, is_error: true }
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      const onOuterAbort = (): void => controller.abort()
      // ctx.signal 透传（用户中断请求时取消抓取）
      ctx.signal?.addEventListener('abort', onOuterAbort, { once: true })
      try {
        let current = parsed
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          await assertPublicHost(current.hostname) // 每跳复检（重定向可能引向内网）
          const res = await fetchImpl(current.toString(), {
            redirect: 'manual',
            signal: controller.signal,
            headers: { 'user-agent': 'ECode/0.1 web_fetch', accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
          })
          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location')
            if (loc === null || hop === MAX_REDIRECTS) {
              return { content: `重定向超限（>${MAX_REDIRECTS} 跳）或缺失 Location`, is_error: true }
            }
            current = new URL(loc, current) // 相对 Location 以当前页为基准
            continue
          }
          if (res.status >= 400) {
            return { content: `HTTP ${res.status} ${current.toString()}`, is_error: true }
          }
          const body = await res.text()
          const contentType = res.headers.get('content-type') ?? ''
          const text = contentType.includes('html') ? htmlToText(body) : body
          if (text.trim() === '') {
            return { content: `页面无有效文本内容（可能是纯前端渲染）：${current.toString()}`, is_error: true }
          }
          const { text: clipped, truncated } = truncateMiddle(text)
          return {
            content: `URL: ${current.toString()}${truncated ? '（已截断）' : ''}\n\n${clipped}`,
          }
        }
        return { content: '重定向超限', is_error: true }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('abort')) return { content: `抓取超时或被中断（${FETCH_TIMEOUT_MS}ms）：${url}`, is_error: true }
        // SSRF 拦截（assertPublicHost throw）与网络错误都在此返回——内网拦截是明确 is_error
        return { content: `抓取失败：${msg}`, is_error: true }
      } finally {
        clearTimeout(timer)
        ctx.signal?.removeEventListener('abort', onOuterAbort)
      }
    },
  }
}

export const webFetchTool: Tool = createWebFetchTool()
