# ECode 编码 / 工作偏好

> 本项目专属偏好。跨项目通用规范见 [CLAUDE.md §一~七](../../CLAUDE.md)。

## Testing：防假绿 5 条

> 起因：`/help` 假绿 bug（2026-08-06）。`tests/ui/repl-human.test.tsx` 测试名说测「`/help` 输出」，setup 却调 `enterConversation()` 偷换前提，没测「一启动就敲 /help」的真实首条场景，导致 `src/ui/app.tsx` 里命令分支在 `setStarted(true)` 之前 return 的 bug 测试全绿——直到真人跑出来才发现。
> 写 L2 ink 测试（`repl-human.test.tsx` 一类，用 `simulate()` 驱动真实 `<App>`）时必守：

1. **从最小前置状态起步**：被测功能尽量从「真实首次」状态开始，setup 越少越接近真实。
2. **每个「首次触发」功能必有零状态用例**：首条即 X（首条命令、首次提交、首次触发某分支）都要从零状态测一条，不能只测中途。
3. **写完测试，故意破坏对应代码验红**（mutation 思维）：能为一处 bug 变红才是真测试；怎么改都绿的就是假绿。
4. **测试名诚实反映前置**：`/help 输出` 掩盖了它依赖「已进对话」；应叫 `对话中途 /help`，或拆成「首条 /help」「中途 /help」两条。
5. **L2 之外保留真实冒烟**：`started` 这类「控制渲染分支」的状态机 bug，L2 单测未必覆盖；定期 `npm run dev` 或上 L3 tmux 过核心路径。

关联：踩坑机理见 [debugging.md](./debugging.md)；方向 D 全文见 `docs/20260806173000_REPL交互优化-调研总览.md` 第六节。
