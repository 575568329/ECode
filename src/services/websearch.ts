/**
 * WebSearch 服务（M10-P1，三层 provider：搜索 MCP 优先 → cn.bing RSS 默认 → 智谱可选）。
 *
 * bing 层：抓 `cn.bing.com/search?q=…&format=rss`（官方 RSS 参数，标准 XML）——免费无 key，
 * 国内直连实测可达；pubDate 是本地化格式**原文透传不解析**；诚实边界尾注（版权灰色/风控可能）。
 * zhipu 层：POST /api/paas/v4/web_search（v1.1 已核实规格），engine 默认 search_std。
 * searchFuse（限额自护，与 M9 quality 熔断显式区分命名）：同会话连续两次失败（429/空结果）
 * → 本会话内短路，返回配置指引不再打请求。
 */

export interface SearchResultItem {
  title: string
  url: string
  snippet: string
  pubDate?: string // 原文透传（bing 为本地化格式，不解析）
  media?: string
}

export interface SearchOutcome {
  results: SearchResultItem[]
  /** 结果尾注（诚实边界/成本透明/失败指引） */
  footer: string
}

export interface WebSearchProvider {
  readonly name: 'bing' | 'zhipu'
  search(params: { query: string; domain?: string; recency?: string }): Promise<SearchOutcome>
}

/** fetch 实现注入（测试 mock；缺省 global fetch） */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const SEARCH_TIMEOUT_MS = 25_000
const SNIPPET_MAX_CHARS = 500
const FUSE_LIMIT = 2

/** XML 实体解码（RSS 内容区常见四类） */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

/** CDATA / 实体混合内容提取 */
function extractTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`).exec(xml)
  if (m === null) return undefined
  return decodeXmlEntities(m[1] ?? m[2] ?? '')
}

/** RSS → 结果条目（标准 XML 结构稳定，轻量正则——不引 XML 库） */
export function parseRssItems(xml: string): SearchResultItem[] {
  const items: SearchResultItem[] = []
  const re = /<item>([\s\S]*?)<\/item>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const block = m[1] ?? ''
    const title = extractTag(block, 'title')
    const link = extractTag(block, 'link')
    if (title === undefined || link === undefined) continue
    const snippet = (extractTag(block, 'description') ?? '').trim()
    items.push({
      title: title.trim(),
      url: link.trim(),
      snippet: snippet.length > SNIPPET_MAX_CHARS ? `${snippet.slice(0, SNIPPET_MAX_CHARS)}…` : snippet,
      pubDate: extractTag(block, 'pubDate'),
    })
  }
  return items
}

/** 编号列表格式化（CC 范式）+ Sources 尾注 */
export function formatResults(items: SearchResultItem[], footer: string): string {
  if (items.length === 0) return `${footer}\n\n（无搜索结果）`
  const lines = items.map((r, i) => {
    const date = r.pubDate !== undefined ? ` · ${r.pubDate}` : ''
    return `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}${date}`
  })
  return `${lines.join('\n')}\n\n回答时请列出 Sources（引用上述来源）。${footer}`
}

/** 限额自护（会话级）：连续失败达阈值后短路 */
export class SearchFuse {
  private failures = 0
  get tripped(): boolean {
    return this.failures >= FUSE_LIMIT
  }
  recordFailure(): void {
    this.failures += 1
  }
  recordSuccess(): void {
    this.failures = 0
  }
}

export interface BingProviderOpts {
  fetchImpl?: FetchLike
  fuse?: SearchFuse
  /** 结果条数上限（默认 10——RSS 固定输出量） */
  maxResults?: number
}

/** bing RSS provider（默认层） */
export function makeBingProvider(opts: BingProviderOpts = {}): WebSearchProvider {
  const doFetch = opts.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i))
  const fuse = opts.fuse ?? new SearchFuse()
  const FOOTER = '\n(web_search · cn.bing RSS · 免费 · 不支持时间过滤参数（recency 被忽略，按结果日期自行判断） · 结果为个人非商业聚合用途，重度使用可能被风控；高质量搜索可配置搜索 MCP 或 webSearch.provider=zhipu)'
  return {
    name: 'bing',
    async search({ query, domain }) {
      if (fuse.tripped) {
        return {
          results: [],
          footer: '搜索已在本会话暂停（连续失败熔断）——建议配置搜索类 MCP server，或 config 设 webSearch.provider=zhipu。',
        }
      }
      const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=${opts.maxResults ?? 10}`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
      try {
        const res = await doFetch(url, { signal: controller.signal })
        if (res.status === 429) {
          fuse.recordFailure()
          return { results: [], footer: `搜索被限流（429）${fuse.tripped ? '——已达熔断阈值，本会话暂停自动搜索' : ''}。` }
        }
        const xml = await res.text()
        let items = parseRssItems(xml)
        if (domain !== undefined && domain !== '') {
          // RSS 端点不支持域名过滤——模型侧过滤（降级语义，方案 v1.6 已记）
          const d = domain.toLowerCase()
          items = items.filter((r) => r.url.toLowerCase().includes(d))
        }
        if (items.length === 0) {
          fuse.recordFailure()
          return { results: [], footer: `无搜索结果${fuse.tripped ? '（连续空结果已达熔断阈值，本会话暂停）' : ''}——可换个问法重试，或配置搜索 MCP/zhipu。` }
        }
        fuse.recordSuccess()
        return { results: items.slice(0, opts.maxResults ?? 10), footer: FOOTER }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export interface ZhipuProviderOpts {
  apiKey: string
  fetchImpl?: FetchLike
  fuse?: SearchFuse
  engine?: 'search_std' | 'search_pro' | 'search_pro_sogou' | 'search_pro_quark'
}

interface ZhipuResponse {
  search_result?: Array<{ title?: string; link?: string; content?: string; media?: string; publish_date?: string }>
}

/** 显式 zhipu 缺 key 的回落 bing（首搜 footer 提示一次——D5"回落并提示"的提示半边） */
function makeFallbackNotifiedBing(): WebSearchProvider {
  const inner = makeBingProvider()
  let notified = false
  return {
    name: 'bing',
    async search(params) {
      const r = await inner.search(params)
      if (!notified) {
        notified = true
        return { results: r.results, footer: `${r.footer}
（提示：webSearch.provider=zhipu 未生效——缺 apiKey，已回落免费 bing 引擎；配置 webSearch.apiKey 后重启生效）` }
      }
      return r
    },
  }
}

/** zhipu provider（可选质量层；v1.1 已核实规格） */
export function makeZhipuProvider(opts: ZhipuProviderOpts): WebSearchProvider {
  const doFetch = opts.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i))
  const fuse = opts.fuse ?? new SearchFuse()
  const engine = opts.engine ?? 'search_std'
  const price: Record<string, string> = { search_std: '¥0.01', search_pro: '¥0.03', search_pro_sogou: '¥0.05', search_pro_quark: '¥0.05' }
  const FOOTER = `\n(web_search · 智谱 ${engine} · ${price[engine] ?? '¥0.01'}/次)`
  return {
    name: 'zhipu',
    async search({ query, domain, recency }) {
      if (fuse.tripped) {
        return { results: [], footer: '搜索已在本会话暂停（连续失败熔断）——建议检查 apiKey 或改用默认 bing。' }
      }
      const body: Record<string, unknown> = {
        search_query: query.slice(0, 70),
        search_engine: engine,
        search_intent: true,
        count: 10,
      }
      if (domain !== undefined && domain !== '') body.search_domain_filter = domain
      if (recency !== undefined && recency !== '') body.search_recency_filter = recency
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
      try {
        const res = await doFetch('https://open.bigmodel.cn/api/paas/v4/web_search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (res.status === 429) {
          fuse.recordFailure()
          return { results: [], footer: `搜索被限流（429）${fuse.tripped ? '——已达熔断阈值' : '，稍后重试'}。` }
        }
        if (!res.ok) {
          // 审阅修复（开发席 P2·二轮补遗）：非 429 的 HTTP 失败也计入熔断（原只 429/空结果记，
          // 端点持续 5xx 时熔断门永远不触发=免费层退避失效）；401/400（配置错）不记——非容量信号
          if (res.status >= 500) fuse.recordFailure()
          return { results: [], footer: `搜索失败（HTTP ${res.status}）——${res.status === 401 || res.status === 400 ? '检查 webSearch.apiKey 配置' : '服务暂不可用，稍后重试'}。` }
        }
        const json = (await res.json()) as ZhipuResponse
        const items = (json.search_result ?? [])
          .filter((r) => r.title !== undefined && r.link !== undefined)
          .map((r) => ({
            title: r.title ?? '',
            url: r.link ?? '',
            snippet: (r.content ?? '').slice(0, SNIPPET_MAX_CHARS),
            pubDate: r.publish_date,
            media: r.media,
          }))
        if (items.length === 0) {
          fuse.recordFailure()
          return { results: [], footer: `无搜索结果${fuse.tripped ? '（连续空结果已达熔断阈值）' : ''}——可换问法或 engine。` }
        }
        fuse.recordSuccess()
        return { results: items, footer: FOOTER }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/**
 * 三层装配判定（启动期）：
 * 返回 null = 不注册内置 web_search（搜索类 MCP 命中）；
 * 返回 provider 实例（bing 默认 / zhipu 配置后）。
 */
export function resolveSearchProvider(config: {
  webSearch?: { provider?: string; apiKey?: string; engine?: ZhipuProviderOpts['engine']; preferMcp?: string[] }
  mcpServers?: Record<string, unknown>
}): WebSearchProvider | null {
  const ws = config.webSearch
  const mcpNames = Object.keys(config.mcpServers ?? {})
  // ① 搜索 MCP 判定：preferMcp 显式声明 > server 名启发式（终审 P1-2：收紧为 search/searxng——
  //    裸 'web' 的假阳性方向是"非搜索 server 被判搜索→内置不注册→用户失去搜索"，害处大于收益）
  const explicit = ws?.preferMcp?.filter((n) => mcpNames.includes(n)) ?? []
  const heuristic = mcpNames.filter((n) => /(^|[-_/.])(search|searxng)/i.test(n)) // 复审 P2-7：词首限定——research-* 类前缀名不误判
  if (explicit.length > 0 || heuristic.length > 0) return null
  // ③ zhipu 配置后（显式 provider，或 provider 缺省但配了 key）；终审 P1-3：无 key 回落 bing（D5 承诺）
  const wantsZhipu = ws?.provider === 'zhipu' || (ws?.provider === undefined && ws?.apiKey !== undefined && ws.apiKey !== '')
  if (wantsZhipu && ws?.apiKey !== undefined && ws.apiKey !== '') {
    return makeZhipuProvider({ apiKey: ws.apiKey, engine: ws.engine })
  }
  // 复审 P1-B：D5"回落并提示"的提示半边——显式选 zhipu 但缺 key 静默换引擎是预期错位
  if (ws?.provider === 'zhipu') {
    return makeFallbackNotifiedBing()
  }
  // ② 默认 bing（零配置零 key）
  return makeBingProvider()
}
