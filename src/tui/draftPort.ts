/**
 * 审阅 P1-1（草稿状态机脱靶修复）方案 B 的类型面：
 * 审批卡 hasDraft 判定的权威源——主输入框（InputStream cur.text）的只读挂口。
 *
 * 为什么需要独立类型文件：TuiApp（消费方）与 InputStream（提供方）互不 import 对方
 * （避免循环依赖），端口类型收敛于此。模块槽在 TuiApp 侧（draftPortRef）。
 */
export interface InputDraftPort {
  /** 当前主输入框完整文本（含斜杠前缀；inactive 期间仍返回真实值） */
  read(): string
}
