# 踩坑记录

> 跨设备同步（git 跟踪）。遇到非显而易见的坑，记这里；解决后更新"解决"段。
> 索引在 [MEMORY.md](./MEMORY.md)。

---

## #001 `--env-file` 不覆盖已存在的环境变量

**日期**：2026-07-29
**影响**：`.env` 配置"看起来没生效"，模型/端点被悄悄替换。

### 现象
在 Claude Code 环境里跑 `npm run dev -- "任务"`，`.env` 里写的 `ANTHROPIC_MODEL=deepseek-v4-pro`，但运行时打印 `model: GLM-5.2`——配置被忽略了，且请求实际打到了别的端点（用父进程的 env 跑通了）。

### 根因
Node 的 `--env-file` / `--env-file-if-exists` 语义是**只设置尚未存在的变量，不覆盖**：
- Claude Code（harness）启动时已向进程注入了一整套 `ANTHROPIC_*` 环境变量（来自 settings.json 的 `env` 块）。
- 这些继承来的变量优先级高于 `.env` 文件，导致 `.env` 里的同名值被压过去。

### 判断方法
打印实际生效的值，别假设 `.env` 一定会赢：
```bash
node -e "console.log(process.env.ANTHROPIC_MODEL)"
```

### 解决
- **普通终端**（没有 export 过 `ANTHROPIC_*`）：不受影响，`.env` 正常生效，无需处理。
- **在已注入 env 的环境里调试**：用干净环境跑，强制只用 `.env`：
  ```bash
  env -i PATH="$PATH" SYSTEMROOT="$SYSTEMROOT" USERPROFILE="$USERPROFILE" \
    npx tsx --env-file-if-exists=.env src/index.ts "任务"
  ```
  注意 `env -i` 会清掉 `TMPDIR`，见下方 #002。
- **若希望 `.env` 强制覆盖**：在代码里显式读 `.env` 并覆盖 `process.env`（如引入 dotenv，它默认覆盖），但这与 Node 原生语义相反，按需取舍。

---

## #002 `env -i` 清空 TMPDIR 导致 tsx 缓存写到 `./undefined/`

**日期**：2026-07-29
**触发场景**：配合 #001 用 `env -i` 跑测试时。

### 现象
项目根目录冒出一个 `undefined/temp/tsx-about/...` 目录，里面是 tsx 的编译缓存。

### 根因
`env -i` 清空了所有环境变量，tsx 找不到临时目录变量（`TMPDIR` / `TEMP` / `TMP`），回退成字符串拼接 `"undefined/temp/..."` 写到**相对路径**（当前工作目录下）。

### 解决
用 `env -i` 时手动保留临时目录变量：
```bash
env -i PATH="$PATH" TMPDIR="$TMPDIR" TEMP="$TEMP" TMP="$TMP" \
  SYSTEMROOT="$SYSTEMROOT" npx tsx ...
```
测试产生的 `undefined/` 目录直接 `rm -rf` 删掉即可，不入库。
