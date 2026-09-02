/**
 * 进程环境预设（必须是 cli/index.ts 的**第一个 import**——ESM hoisting 下任何后置
 * 赋值都晚于 react/react-reconciler 的加载，写在入口体内无效）。
 *
 * 2026-09-02 批2c（P1-A 真机 1.3G 根因收官）：NODE_ENV 未设时默认 production。
 * 此前 dist/dev 双入口都不设 → react-reconciler 恒走 development 构建，其 devtools
 * 记账串（"Changed Props"/"± children" 等）每渲染滞留——RSS 探针实测 dev 模式
 * TimelineView 路径每轮 +100MB 且强制 GC 不回收；production 三轮全平（17.9→18.2MB）。
 * 需要 React dev 警告/DevTools 诊断时显式 NODE_ENV=development 启动。
 */
if (process.env.NODE_ENV === undefined) process.env.NODE_ENV = 'production'
export {}
