import { describe, expect, it } from 'vitest'
import { CredentialStore } from '../../src/server/credentials.js'

describe('CredentialStore（M14-C2①/D13 凭据条目化）', () => {
  it('命中返回等级，未命中返回 null', () => {
    const store = new CredentialStore()
    store.add('tok-primary', 'primary')
    store.add('tok-pass', 'lan-password')
    store.add('tok-dev', 'device')
    expect(store.verify('tok-primary')).toBe('primary')
    expect(store.verify('tok-pass')).toBe('lan-password')
    expect(store.verify('tok-dev')).toBe('device')
    expect(store.verify('wrong')).toBeNull()
    expect(store.verify('')).toBeNull()
  })

  it('同 secret 多条目：全量扫描不短路，返回最后命中（等价命中文档化）', () => {
    const store = new CredentialStore()
    store.add('dup', 'device')
    store.add('dup', 'primary')
    expect(store.verify('dup')).toBe('primary')
  })

  it('hasPrimary：一等凭据存在性（device 不算）', () => {
    const onlyDevice = new CredentialStore()
    onlyDevice.add('d', 'device')
    expect(onlyDevice.hasPrimary).toBe(false)
    const withPrimary = new CredentialStore()
    withPrimary.add('p', 'primary')
    withPrimary.add('d', 'device')
    expect(withPrimary.hasPrimary).toBe(true)
  })

  it('空串条目被拒（不产生恒真凭据）', () => {
    const store = new CredentialStore()
    store.add('', 'primary')
    expect(store.verify('')).toBeNull()
    expect(store.hasPrimary).toBe(false)
  })
})
