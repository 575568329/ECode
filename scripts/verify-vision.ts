// 障碍②技术 spike：验证 coding 端点 vs 普通端点对视觉模型 + 图片的支持。
// 三组请求定位障碍：
//   A: coding 端点 + glm-4.5v 纯文本   → 探「coding 端点认不认视觉模型」
//   B: coding 端点 + glm-4.5v + 图片   → 探「coding 端点收不收 image_url」
//   C: 普通端点 + glm-4.5v + 图片      → 对照基准（文档示例端点，应通）
// 安全：只打印状态码 + 响应摘要，绝不打印 API key。
//
// 跑：npx tsx --env-file-if-exists=.env scripts/verify-vision.ts [模型名]
const RED_PNG_DATAURL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const KEY = process.env.ZHIPUAI_API_KEY;
if (!KEY) {
  console.error('✗ 未设置 ZHIPUAI_API_KEY（请在 .env 填入智谱 key）');
  process.exit(1);
}

const MODEL = process.argv[2] ?? 'glm-4.5v';
const CODING = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions';
const NORMAL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

async function probe(label: string, url: string, body: unknown): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`\n=== ${label} ===\nHTTP ${res.status}`);
    console.log(text.slice(0, 600));
  } catch (err) {
    console.log(`\n=== ${label} ===\n网络错误: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const textBody = {
  model: MODEL,
  messages: [{ role: 'user', content: '回复"收到"两个字即可' }],
};
const imageBody = {
  model: MODEL,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张图主要是什么颜色？一个词回答。' },
        { type: 'image_url', image_url: { url: RED_PNG_DATAURL } },
      ],
    },
  ],
};

console.log(`模型: ${MODEL}`);
await probe(`A · coding 端点 + 纯文本`, CODING, textBody);
await probe(`B · coding 端点 + 图片`, CODING, imageBody);
await probe(`C · 普通端点 + 图片（对照）`, NORMAL, imageBody);
