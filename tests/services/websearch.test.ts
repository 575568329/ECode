/** WebSearch 测（M10-P1）：RSS 解析/双 provider mock/三层判定/searchFuse/格式化。 */
import { describe, expect, it, vi } from 'vitest'
import {
  parseRssItems,
  formatResults,
  SearchFuse,
  makeBingProvider,
  makeZhipuProvider,
  resolveSearchProvider,
  type FetchLike,
} from '../../src/services/websearch.js'

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>Node.js 官网</title><link>https://nodejs.org/</link><description>Run JavaScript everywhere</description><pubDate>周一, 17 8月 2026 04:22:00 GMT</pubDate></item>
<item><title><![CDATA[CSDN 教程]]></title><link>https://blog.csdn.net/x</link><description>&lt;p&gt;安装配置&lt;/p&gt;</description></item>
</channel></rss>`

function fetchText(body: string, status = 200): FetchLike {
  return vi.fn(async () => new Response(body, { status })) as unknown as FetchLike
}

describe('parseRssItems', () => {
  it('标准 item/CDATA/实体解码/pubDate 原文透传', () => {
    const items = parseRssItems(RSS)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ title: 'Node.js 官网', url: 'https://nodejs.org/' })
    expect(items[0]?.pubDate).toBe('周一, 17 8月 2026 04:22:00 GMT') // 本地化原文不解析
    expect(items[1]?.title).toBe('CSDN 教程')
    expect(items[1]?.snippet).toContain('<p>') // 实体已解码
  })
  it('缺 title/link 的 item 跳过', () => {
    expect(parseRssItems('<item><description>x</description></item>')).toHaveLength(0)
  })
})

describe('formatResults', () => {
  it('编号列表 + URL + 摘要 + Sources 尾注 + footer', () => {
    const out = formatResults([{ title: 'A', url: 'https://a', snippet: 'sa' }], '\n(footer)')
    expect(out).toContain('1. A')
    expect(out).toContain('https://a')
    expect(out).toContain('Sources')
    expect(out).toContain('(footer)')
  })
})

describe('bing provider', () => {
  it('成功：RSS → 结果 + 诚实边界 footer；URL 带 query 编码', async () => {
    const fetchImpl = fetchText(RSS)
    const p = makeBingProvider({ fetchImpl })
    const r = await p.search({ query: 'node.js 教程' })
    expect(r.results).toHaveLength(2)
    expect(r.footer).toContain('cn.bing RSS')
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain(encodeURIComponent('node.js 教程'))
  })
  it('domain 模型侧过滤（降级语义）；429 记失败；连续两次空结果熔断短路', async () => {
    const p = makeBingProvider({ fetchImpl: fetchText(RSS) })
    const r = await p.search({ query: 'x', domain: 'nodejs.org' })
    expect(r.results).toHaveLength(1)
    const fuse = new SearchFuse()
    const p429 = makeBingProvider({ fetchImpl: fetchText('', 429), fuse })
    await p429.search({ query: 'x' })
    expect(fuse.tripped).toBe(false)
    await p429.search({ query: 'x' })
    expect(fuse.tripped).toBe(true)
    const r3 = await p429.search({ query: 'x' })
    expect(r3.footer).toContain('熔断')
    expect(r3.results).toHaveLength(0)
  })
})

describe('zhipu provider', () => {
  it('成功：search_result 映射 + engine 价格 footer；body 含 domain/recency', async () => {
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) =>
      new Response(JSON.stringify({ search_result: [{ title: 'T', link: 'https://t', content: 'C', publish_date: '2026-08-17' }] }), { status: 200 }),
    ) as unknown as FetchLike
    const p = makeZhipuProvider({ apiKey: 'sk', engine: 'search_pro', fetchImpl })
    const r = await p.search({ query: 'q', domain: 'docs.x.com', recency: 'oneWeek' })
    expect(r.results[0]).toMatchObject({ title: 'T', url: 'https://t' })
    expect(r.footer).toContain('¥0.03')
    const body = JSON.parse((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body as string)
    expect(body.search_domain_filter).toBe('docs.x.com')
    expect(body.search_recency_filter).toBe('oneWeek')
    expect(body.search_engine).toBe('search_pro')
  })
  it('HTTP 401 → 可读 footer（提示 apiKey）', async () => {
    const p = makeZhipuProvider({ apiKey: 'bad', fetchImpl: fetchText('{}', 401) })
    const r = await p.search({ query: 'q' })
    expect(r.footer).toContain('apiKey')
  })
})

describe('resolveSearchProvider（三层判定）', () => {
  it('preferMcp 显式命中 → null（内置不注册）', () => {
    expect(resolveSearchProvider({ webSearch: { preferMcp: ['my-search'] }, mcpServers: { 'my-search': {} } })).toBeNull()
  })
  it('server 名启发式命中（search/searxng）→ null；自定义名未声明不误判', () => {
    expect(resolveSearchProvider({ mcpServers: { 'web-search-svc': {} } })).toBeNull()
    expect(resolveSearchProvider({ mcpServers: { 'db-service': {} } })?.name).toBe('bing')
  })
  it('终审 P1-2：非搜索 server 名含 web（webhook/webpack/web-fetch）不误判——内置照常注册', () => {
    expect(resolveSearchProvider({ mcpServers: { 'webhook-notifier': {} } })?.name).toBe('bing')
    expect(resolveSearchProvider({ mcpServers: { 'webpack-build': {} } })?.name).toBe('bing')
    expect(resolveSearchProvider({ mcpServers: { 'web-fetch': {} } })?.name).toBe('bing')
  })
  it('终审 P1-3：显式 zhipu 但无 apiKey → 回落 bing（D5）', async () => {
    expect(resolveSearchProvider({ webSearch: { provider: 'zhipu' } })?.name).toBe('bing')
    expect(resolveSearchProvider({ webSearch: { provider: 'zhipu', apiKey: '' } })?.name).toBe('bing')
    // 复审 P1-B：回落 bing 的首搜 footer 带一次性提示（D5"并提示"半边）
    const p = resolveSearchProvider({ webSearch: { provider: 'zhipu' } })
    expect(p).not.toBeNull()
    if (p !== null) {
      const r = await p.search({ query: 'x' })
      expect(r.footer).toContain('未生效')
      expect(r.footer).toContain('webSearch.apiKey')
      const r2 = await p.search({ query: 'y' })
      expect(r2.footer).not.toContain('未生效') // 只提示一次
    }
  })
  it('复审 P2-7：research- 类前缀 server 名不误判（词首限定）', () => {
    expect(resolveSearchProvider({ mcpServers: { 'research-index': {} } })?.name).toBe('bing')
  })
  it('默认零配置 → bing；显式 zhipu 或配了 key → zhipu', () => {
    expect(resolveSearchProvider({})?.name).toBe('bing')
    expect(resolveSearchProvider({ webSearch: { provider: 'zhipu', apiKey: 'k' } })?.name).toBe('zhipu')
    expect(resolveSearchProvider({ webSearch: { apiKey: 'k' } })?.name).toBe('zhipu')
  })
})
