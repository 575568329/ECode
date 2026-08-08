// Bash 命令 arity 归约（抄 opencode permission/arity.ts 思路，非 tree-sitter）。
// 字典记录「命令前缀 → 期望 token 数」；归约时最长前缀匹配胜出。
//
// Why：bash 权限按命令前缀分级——'git checkout main' 归约成 'git checkout'，
// allow_always 生成 pattern 时只保留命令骨架，避免把参数（main）固化进规则。
// 这样 'git checkout x' 下次能命中，但 'git push' 不会误放行。

/**
 * ARITY 字典：命令前缀（空格连接）→ 该前缀作为权限粒度时保留的 token 数。
 * - 单 token 命令（ls/cat/echo…）= 1：flags 与参数全部截断。
 * - 子命令工具（git/npm/docker…）顶层 = 2；特定子命令需更多上下文则单列 = 3。
 *
 * 查找走最长前缀匹配（见 prefix），故 ['git','checkout','main'] 命中 'git'(2) → ['git','checkout']，
 * 而 ['git','config','user.name'] 命中 'git config'(3) → 整段保留。
 */
const ARITY: Record<string, number> = {
  // ── arity=1：单 token 命令（flags/参数截断） ──
  cat: 1, cd: 1, chmod: 1, chown: 1, cp: 1, curl: 1, df: 1, du: 1,
  echo: 1, env: 1, export: 1, grep: 1, head: 1, hostname: 1, kill: 1,
  killall: 1, less: 1, ln: 1, ls: 1, mkdir: 1, more: 1, mv: 1, ps: 1,
  pwd: 1, rm: 1, rmdir: 1, sed: 1, sleep: 1, sort: 1, source: 1, tail: 1,
  tee: 1, top: 1, touch: 1, uname: 1, uniq: 1, unset: 1, wc: 1, which: 1,
  whoami: 1, yes: 1,
  // 语言运行时（命令名本身即足够，参数截断）
  node: 1, python: 1, python3: 1, pip: 1, pip3: 1, uv: 1, go: 1, ruby: 1,
  java: 1, javac: 1, make: 1, cmake: 1,

  // ── arity=3：云 CLI（命令+子命令+目标 三层才有意义） ──
  aws: 3, az: 3, gcloud: 3, gh: 3, doctl: 3, sfdx: 3,

  // ── arity=2 顶层 + arity=3 子命令（命令+子命令二元即足够，少数需三层） ──
  git: 2,
  'git config': 3, 'git remote': 3, 'git stash': 3,
  npm: 2,
  'npm run': 3, 'npm exec': 3, 'npm init': 3, 'npm view': 3,
  npx: 2,
  pnpm: 2,
  'pnpm run': 3, 'pnpm exec': 3, 'pnpm dlx': 3,
  yarn: 2,
  'yarn run': 3, 'yarn dlx': 3,
  docker: 2,
  'docker build': 3, 'docker compose': 3, 'docker container': 3,
  'docker image': 3, 'docker network': 3, 'docker volume': 3, 'docker run': 3,
  kubectl: 2,
  'kubectl kustomize': 3, 'kubectl rollout': 3,
  cargo: 2,
  'cargo run': 3, 'cargo add': 3, 'cargo build': 3, 'cargo test': 3,
  bun: 2,
  'bun run': 3, 'bun x': 3,
  deno: 2,
  'deno run': 3, 'deno task': 3,
  helm: 2,
  terraform: 2,
};

/** 剥离 token 前后的成对单/双引号（'"git"' → 'git'）。 */
function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === "'" || first === '"') && first === last) {
      return token.slice(1, -1);
    }
  }
  return token;
}

/** 命令字符串 → token 数组（空白折叠拆分 + 剥引号 + 去空）。 */
function tokenize(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(stripQuotes);
}

/**
 * 最长前缀匹配归约：从 tokens.length 向下扫到 1，首个 ARITY 命中的前缀决定保留长度。
 * 全不命中 → 取首 token（保守：未知命令按其名归类）；空输入 → []。
 */
export function prefix(tokens: string[]): string[] {
  if (tokens.length === 0) return [];
  for (let i = tokens.length; i >= 1; i--) {
    const arity = ARITY[tokens.slice(0, i).join(' ')];
    if (arity !== undefined) {
      return tokens.slice(0, arity);
    }
  }
  return tokens.slice(0, 1);
}

/** 命令字符串 → 归约后字符串（tokenize + prefix + 空格连接）。 */
export function reduceCommand(command: string): string {
  return prefix(tokenize(command)).join(' ');
}

/**
 * allow_always pattern：'git checkout main' → 'git checkout *'。
 * 归约后追加 ' *'（与 wildcard.match 尾部可选语义配合：既匹配裸命令也匹配带参数）。
 */
export function toAlwaysPattern(command: string): string {
  return `${reduceCommand(command)} *`;
}

/**
 * 复合命令拆段：按 shell 复合操作符（&&/||/;/|）拆分，不要求两侧空格。
 *
 * Why 不用「两侧空格保守不拆」策略：尾部 ' *' 的 pattern 贪婪匹配会让
 * 'npm install; rm -rf /'（分号前无空格）整段命中 'npm install *' → 越权放行（compound bypass）。
 * 拆得越细越安全（多段多查多问）；误拆（操作符在引号内，如 echo "a;b"）只会多问不会放行，可接受。
 * 引号内操作符的精确处理需 tree-sitter（§9.3 红线禁用原生二进制依赖），留作已知限制。
 */
export function splitCompound(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\|)/)
    .map((seg) => seg.trim())
    .filter(Boolean);
}
