/**
 * Tool Registry 实现（含 AJV 校验）。
 *
 * register 时预编译 JSON Schema → ValidateFunction（缓存，避免每次 validate 重复 compile）。
 * validate 不通过直接返回 ok:false（loop 转 is_error 的 ToolResult，根本不进 Tool）。
 */

import AjvImport, { type ValidateFunction } from 'ajv'
import type { Tool, ToolRegistry } from './interface.js'
import type { ToolSpec } from '../core/types.js'

/** ajv 实例的鸭子类型（避开 ajv 8 在 NodeNext 下的 default interop 类型问题）。 */
type AjvInstance = {
  compile: (schema: object) => ValidateFunction
  errorsText: (errors?: unknown) => string
}

// ajv 8 在 NodeNext 下 default 可能被解析为 namespace，运行时 default 或自身是构造器
const Ajv =
  (AjvImport as unknown as { default?: new (o: object) => AjvInstance }).default ??
  (AjvImport as unknown as new (o: object) => AjvInstance)

export class ToolRegistryImpl implements ToolRegistry {
  private readonly tools = new Map<string, Tool>()
  private readonly validators = new Map<string, ValidateFunction>()
  private readonly ajv = new Ajv({ allErrors: true })

  register(t: Tool): void {
    this.tools.set(t.name, t)
    // skipLocalValidate（外部工具）：跳过预编译——外部 schema 含 $ref/非法结构会让
    // ajv.compile 直接 throw 炸掉整个注册循环（v3 P1-2）；校验透传给 server
    if (t.skipLocalValidate === true) {
      this.validators.delete(t.name)
      return
    }
    // 预编译并缓存（工具 schema 不变，一次编译复用）
    this.validators.set(t.name, this.ajv.compile(t.input_schema))
  }

  unregister(name: string): void {
    this.tools.delete(name)
    this.validators.delete(name)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }))
  }

  validate(name: string, input: unknown): { ok: true } | { ok: false; error: string } {
    const tool = this.tools.get(name)
    if (!tool) return { ok: false, error: `工具 ${name} 不存在` }
    if (tool.skipLocalValidate === true) return { ok: true } // 透传 server 校验（D13）
    const validate = this.validators.get(name)
    if (!validate) return { ok: false, error: `工具 ${name} 校验器未初始化` }
    if (validate(input)) return { ok: true }
    return { ok: false, error: `参数校验失败: ${this.ajv.errorsText(validate.errors)}` }
  }
}
