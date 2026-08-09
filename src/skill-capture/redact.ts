// ============================================================
// 自由文本脱敏（M6 阶段D 技能生成 · 记录层）—— §9.2 红线 + §17🔴2
// ============================================================
//
// 用途：recorder 记录用户输入前先脱敏，确保 observations.jsonl 不落密钥/凭证。
// 与 providers 的 maskSecret（单值掩码，给 config 透出用）区分：本函数面向**自由文本**，
// 用正则识别常见密钥形态并整体替换为 [REDACTED]。
//
// 规则保守优先：带阈值（sk- 需 ≥10 字符）防误报普通短串；不脱敏无密钥文本（原样返回）。

/** sk- 开头的 API token（Anthropic/OpenAI 风格）；sk- 后需 ≥10 字符防 sk-ip 类误报。 */
const SK_TOKEN = /\bsk-[A-Za-z0-9_-]{10,}\b/g;
/** Authorization: Bearer xxx。 */
const BEARER = /Bearer\s+[A-Za-z0-9._-]+/gi;
/** token= / api_key= / apikey= 赋值（含可选引号）；保留 key 名，只替值。 */
const KEY_ASSIGN = /(token|api_?key)\s*[=:]\s*["']?[A-Za-z0-9._-]+["']?/gi;
/** AWS access key id（AKIA + 16 位大写字母数字）。 */
const AWS_AKIA = /\bAKIA[A-Z0-9]{16}\b/g;

/**
 * 脱敏自由文本中的常见密钥形态 → [REDACTED]。
 * 顺序：先消费 token=/api_key= 的 value（避免 value 内的 sk- 被二次匹配残留），再扫独立密钥。
 * 无密钥则原样返回（零开销路径外的正则替换，文本量小可接受）。
 */
export function redactSecrets(text: string): string {
  return text
    .replace(KEY_ASSIGN, '$1=[REDACTED]')
    .replace(SK_TOKEN, '[REDACTED]')
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(AWS_AKIA, '[REDACTED]');
}
