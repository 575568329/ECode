/**
 * R5 设备管理面（双形态）：
 * - 直连形态（用户级凭据）：配对设备列表+吊销（POST /api/devices*——device 档 403 栅栏同源）+
 *   relay 链路状态；配对入口提示 `ecode pair`（终端 QR 先行——D1 拍板）。
 * - 中继形态（手机）：已配对主机列表+在线徽标（/v1/hosts/online——多机区分，G-R2 验收面）+
 *   点按切换/移除/断开本机连接。
 */
import { useCallback, useEffect, useState } from 'react'
import { X, Trash2 } from 'lucide-react'
import { getToken } from './connect'
import { activateHost, fetchHostsOnline, listHosts, relayDisconnect, relayGetCfg, removeHost, type HostOnline } from './relay'

interface DeviceRow {
  deviceId: string
  name: string
  scope: string
  pairedAt: string
  note?: string
  relayInvite?: { token: string; expiresAt: number }
}

export function DevicesPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const relayMode = relayGetCfg() !== null
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
          <span className="text-sm font-medium">{relayMode ? '设备与主机' : '配对设备'}</span>
          <button onClick={onClose} className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300">
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">{relayMode ? <RelayHosts /> : <DirectDevices onClose={onClose} />}</div>
      </div>
    </div>
  )
}

/** 直连形态：设备列表+吊销（电脑/局域网 web 用） */
function DirectDevices({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [devices, setDevices] = useState<DeviceRow[] | null>(null)
  const [relay, setRelay] = useState<{ connected: boolean; generation?: number } | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const load = useCallback((): void => {
    fetch('/api/devices', { headers: { authorization: `Bearer ${getToken()}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const body = (await r.json()) as { devices?: DeviceRow[]; relay?: { connected: boolean } | null }
        setDevices(body.devices ?? [])
        setRelay(body.relay ?? null)
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
  }, [])
  useEffect(load, [load])
  const revoke = (deviceId: string, name: string): void => {
    if (!window.confirm(`吊销设备「${name}」？其连接将立即断开（不可撤销）。`)) return
    setBusy(deviceId)
    void fetch('/api/devices/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ deviceId }),
    })
      .then(load)
      .finally(() => setBusy(''))
  }
  return (
    <>
      {err !== '' && <div className="text-xs text-red-400">⚠ {err}</div>}
      {relay !== null && (
        <div className="text-[11px] text-neutral-500">
          中继出站：{relay.connected ? <span className="text-emerald-400">已连接（gen {relay.generation ?? '—'}）</span> : <span className="text-amber-400">未连接</span>}
        </div>
      )}
      {devices === null && err === '' && <div className="py-8 text-center text-sm text-neutral-600">载入中…</div>}
      {devices !== null && devices.length === 0 && <div className="py-6 text-center text-xs text-neutral-600">尚无配对设备——电脑端执行 ecode pair 配对（终端出二维码）。</div>}
      {devices !== null &&
        devices.map((d) => (
          <div key={d.deviceId} className="flex items-center gap-2 rounded border border-neutral-800 px-2.5 py-2 text-xs">
            <div className="min-w-0 flex-1">
              <div className="truncate text-neutral-200">
                {d.name} <span className="text-neutral-600">{d.scope === 'full' ? '· 全功能' : '· 对话+只读'}</span>
              </div>
              <div className="truncate text-[10px] text-neutral-600">
                {d.deviceId} · 配对于 {new Date(d.pairedAt).toLocaleString()}
                {d.relayInvite !== undefined ? ' · 中继 invite' : ''}
              </div>
            </div>
            <button
              onClick={() => revoke(d.deviceId, d.name)}
              disabled={busy === d.deviceId}
              title="吊销（立即断开）"
              className="shrink-0 rounded p-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-red-400 disabled:opacity-40"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      <div className="pt-1 text-[10px] leading-relaxed text-neutral-600">
        新设备配对：电脑端 <code className="text-neutral-500">ecode pair &lt;名字&gt;</code>——扫码或把令牌输入手机；吊销即时生效（凭据活摘除+中继断连）。E2E 加密由配对钉住的公钥保障（中继只见密文）。
      </div>
      <button onClick={onClose} className="rounded bg-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-900">
        完成
      </button>
    </>
  )
}

/** 中继形态：已配对主机列表（在线徽标/切换/移除）——多机区分（G-R2 验收面） */
function RelayHosts(): React.JSX.Element {
  const active = relayGetCfg()
  const [hosts, setHosts] = useState(listHosts())
  const [online, setOnline] = useState<Record<string, HostOnline>>({})
  useEffect(() => {
    let alive = true
    const tick = (): void => {
      void fetchHostsOnline().then((o) => {
        if (alive) setOnline(o)
      })
    }
    tick()
    const iv = setInterval(tick, 15_000)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [])
  return (
    <>
      <div className="text-[10px] leading-relaxed text-neutral-600">
        当前连接：<span className="text-neutral-400">{active?.name ?? active?.hostId ?? '—'}</span>（端到端加密已启用，中继只见密文）。
      </div>
      {hosts.map((h) => {
        const st = online[h.hostId]
        const isActive = active?.hostId === h.hostId
        return (
          <div key={h.hostId} className={`flex items-center gap-2 rounded border px-2.5 py-2 text-xs ${isActive ? 'border-neutral-600 bg-neutral-800/60' : 'border-neutral-800'}`}>
            <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${st?.online === true ? 'bg-emerald-500' : 'bg-neutral-600'}`} title={st?.online === true ? '在线' : '离线'} />
            <button
              className="min-w-0 flex-1 text-left"
              onClick={() => {
                if (isActive) return
                activateHost(h.hostId)
                location.reload() // 重挂 WS/项目快照
              }}
            >
              <div className="truncate text-neutral-200">
                {h.name ?? h.hostId}
                {isActive && <span className="ml-1 text-[10px] text-emerald-400">当前</span>}
              </div>
              <div className="truncate text-[10px] text-neutral-600">
                {st?.online === true ? `在线 · ${st.version ?? ''}` : '离线'}
                {' · 配对于 '}
                {new Date(h.pairedAt).toLocaleDateString()}
              </div>
            </button>
            {!isActive && (
              <button
                onClick={() => {
                  removeHost(h.hostId)
                  setHosts(listHosts())
                }}
                title="移除配对记录"
                className="shrink-0 rounded p-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        )
      })}
      {hosts.length === 0 && <div className="py-4 text-center text-xs text-neutral-600">无其他已配对主机。</div>}
      <div className="text-[10px] leading-relaxed text-neutral-600">接入新主机：在该电脑执行 ecode pair，扫码即加入此列表。</div>
      <button onClick={() => relayDisconnect()} className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 hover:border-red-500/50 hover:text-red-400">
        断开设备连接
      </button>
    </>
  )
}
