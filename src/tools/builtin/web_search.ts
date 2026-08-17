/**
 * web_search 工具（M10-P1，readonly 免确认）：联网搜索（provider 由装配层决定——bing RSS 默认/智谱可选）。
 */

import type { Tool } from '../interface.js'
import type { WebSearchProvider } from '../../services/websearch.js'

/** 模块级注入（askUserBridge/setWebFetchLimits 先例——静态 Tool 无 config 通道） */
let provider: WebSearchProvider | null = null

export function setWebSearchProvider(p: WebSearchProvider | null): void {
  provider = p
}

export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    '联网搜索（返回编号列表：标题/URL/摘要/日期）。需要最新信息（库版本/文档/新闻）或不知道 URL 时用；拿到结果后常配合 web_fetch 抓最相关页面全文。',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      domain: { type: 'string', description: '限定域名（如 docs.nodejs.org，可选）' },
      recency: {
        type: 'string',
        description: '时间范围 oneDay/oneWeek/oneMonth/oneYear（可选；部分引擎不支持时按结果日期自行判断）',
      },
    },
    required: ['query'],
  },
  readonly: true,

  async execute(args) {
    if (provider === null) {
      return { content: '搜索未启用（配置了搜索类 MCP 或未装配）', is_error: true }
    }
    const { query, domain, recency } = args as { query: string; domain?: string; recency?: string }
    try {
      const r = await provider.search({ query, domain, recency })
      if (r.results.length === 0) {
        return { content: r.footer, is_error: true } // 空/失败/熔断：footer 即指引
      }
      return { content: formatForTool(r.results, r.footer) }
    } catch (e) {
      return { content: `搜索失败：${e instanceof Error ? e.message : String(e)}`, is_error: true }
    }
  },
}

function formatForTool(items: Array<{ title: string; url: string; snippet: string; pubDate?: string }>, footer: string): string {
  const lines = items.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}${r.pubDate !== undefined ? ` · ${r.pubDate}` : ''}`)
  return `${lines.join('\n')}\n\n回答时请列出 Sources（引用上述来源）。${footer}`
}
