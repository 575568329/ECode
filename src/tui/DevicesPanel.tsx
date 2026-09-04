/**
 * /devices 配对设备面板（R 线）：一个面板覆盖 本机服务信息（地址+token）/查看列表/吊销/
 * 配对新设备（终端二维码+深链）/停止后台 serve。
 *
 * 数据自取（probeRunningDaemon → daemon HTTP；不可达落本地注册表）——面板与宿主零耦合。
 * 交互（PanelShell 惯例）：↑↓ 选择 · 回车 执行 · Esc 返回；
 * 吊销/停止 serve 二次确认（回车选中 → 再回车确认，防误触）；配对成功切二维码视图（任意键返回）。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Box, Text, useInput } from 'ink'
import { PanelShell } from './PanelShell.js'
import { theme } from './theme.js'
import { createPairingFull } from '../server/pairing.js'
import { DeviceRegistry, probeRunningDaemon, revokeDeviceText } from '../server/devices.js'

interface DeviceRow {
  deviceId: string
  name: string
  scope: string
  pairedAt: string
  relayInvite?: { token: string; expiresAt: number }
}

interface PairResultView {
  qrText: string
  link?: string
  name: string
  scope: string
  viaDaemon: boolean
}

export interface ServeInfo {
  /** 本机服务地址（http://127.0.0.1:<port>） */
  address: string
  /** daemon Bearer token（server.json——本机客户端/脚本用） */
  token: string
}

function maskToken(token: string): string {
  if (token.length <= 12) return '•'.repeat(token.length)
  return `${token.slice(0, 8)}…${token.slice(-4)}`
}

export function DevicesPanel({
  onCancel,
  serve,
  onStopServe,
}: {
  onCancel: () => void
  /** 附着态才有（embedded 无后台服务可展示/停止） */
  serve?: ServeInfo
  onStopServe?: () => void
}): ReactElement {
  const [devices, setDevices] = useState<DeviceRow[] | null>(null)
  const [status, setStatus] = useState('')
  const [armed, setArmed] = useState<string | null>(null)
  const [result, setResult] = useState<PairResultView | null>(null)
  const [pairBusy, setPairBusy] = useState(false)
  const [tokenRevealed, setTokenRevealed] = useState(false)
  // 审阅修复（安全席 P1·六批）：token 默认遮蔽（primary 全权凭据，面板不走 alt screen——
  // 明文会被顶进终端 scrollback/截屏不可回收）。回车令牌行切换揭示（复用面板 armed 式交互）

  const load = useCallback(async (): Promise<void> => {
    const daemon = await probeRunningDaemon()
    if (daemon !== null) {
      try {
        const res = await fetch(`http://127.0.0.1:${daemon.port}/api/devices`, {
          headers: { authorization: `Bearer ${daemon.token}` },
          signal: AbortSignal.timeout(3000),
        })
        const r = (await res.json()) as { devices?: DeviceRow[] }
        if (res.ok && Array.isArray(r.devices)) {
          setDevices(r.devices)
          return
        }
      } catch {
        /* daemon 查询失败落本地表 */
      }
    }
    setDevices(new DeviceRegistry().list())
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const pair = async (): Promise<void> => {
    if (pairBusy) return
    setPairBusy(true)
    try {
      const name = `手机-${Math.random().toString(36).slice(2, 6)}`
      const r = await createPairingFull(name, 'chat')
      setResult({ qrText: r.qrText, link: r.link, name: r.name, scope: r.scope, viaDaemon: r.viaDaemon })
      await load()
    } catch (e) {
      setStatus(`配对失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPairBusy(false)
    }
  }

  const revoke = async (id: string): Promise<void> => {
    const msg = await revokeDeviceText(id)
    setStatus(msg)
    setArmed(null)
    await load()
  }

  if (result !== null) {
    return <PairResultView r={result} onBack={() => setResult(null)} />
  }

  const rows = [
    ...(status !== '' ? [{ type: 'header' as const, label: status }] : []),
    // 服务信息（2026-09-04 用户点名：地址+token 直接在 TUI 可见；只读展示行）
    ...(serve !== undefined
      ? [
          { type: 'header' as const, label: `本机服务  ${serve.address}` },
          {
            // 安全席 P1·六批：token 是 item（可选中），回车切换揭示；默认遮蔽——
            // 明文常驻主缓冲会滚进 scrollback/截屏不可回收（与 serveMain「token 不打 stdout」同决策）
            type: 'item' as const,
            value: '__token__' as const,
            label: (
              <Text>
                {' '}🔑 访问令牌{' '}
                {tokenRevealed ? serve.token : maskToken(serve.token)}
                <Text dimColor>{tokenRevealed ? '（回车重新遮蔽）' : '（回车显示完整）'}</Text>
              </Text>
            ),
          },
        ]
      : []),
    // 停止 serve 仅附着态可见（embedded 无后台服务可停）
    ...(serve !== undefined && onStopServe !== undefined
      ? [
          {
            type: 'item' as const,
            value: '__stop__' as const,
            label: (
              <Text color={theme.error}>
                {' '}
                ⏹ 停止后台 serve
                {armed === '__stop__' ? ' —— 再回车确认（断开手机/远程，TUI 转本地模式；Esc 取消）' : ''}
              </Text>
            ),
          },
        ]
      : []),
    { type: 'item' as const, value: '__pair__' as const, label: pairBusy ? ' ⏳ 生成配对中…' : ' ➕ 配对新设备（回车生成二维码+链接）' },
    { type: 'header' as const, label: `已配对设备（${devices?.length ?? 0}）` },
    ...(devices ?? []).map((d) => ({
      type: 'item' as const,
      value: d.deviceId,
      label: (
        <Text>
          {' '}
          {d.name}
          <Text color={theme.border}> [{d.scope === 'full' ? '全功能' : '对话+只读'}]</Text> {d.pairedAt.slice(0, 10)}
          {d.relayInvite !== undefined ? <Text color={theme.info}> [中继]</Text> : ''}
          {armed === d.deviceId ? <Text color={theme.error}> —— 再回车确认吊销（Esc 取消）</Text> : ''}
        </Text>
      ),
    })),
  ]

  return (
    <PanelShell
      title="配对设备"
      subtitle="新设备配对 · 吊销 · 管理"
      rows={rows}
      onPick={(v) => {
        if (v === '__token__') {
          setTokenRevealed((r) => !r)
          return
        }
        if (v === '__stop__') {
          // 停止 serve 二次确认（同吊销 armed 模式）；确认后交宿主回调（停进程+降级本地）
          if (armed === '__stop__') {
            setArmed(null)
            onStopServe?.()
          } else setArmed('__stop__')
          return
        }
        if (v === '__pair__') {
          void pair()
          return
        }
        if (typeof v === 'string') {
          // 吊销二次确认：首次回车仅武装（行内提示），再回车才真吊销
          if (armed === v) void revoke(v)
          else setArmed(v)
        }
      }}
      onCancel={() => {
        if (armed !== null) setArmed(null)
        else onCancel()
      }}
      onCursor={() => {
        // 安全席/正确性席 P2·六批：光标移动即解除武装——armed 行被 ↑↓/搜索/窗口滚动隐藏后
        // 单回车误执行的破坏面（stop 为最高破坏级动作）
        if (armed !== null) setArmed(null)
      }}
      emptyHint="（尚无配对设备——回车「配对新设备」生成二维码）"
      keyHints="↑↓ 选择 · 回车 执行/二次确认 · Esc 返回"
    />
  )
}

/** 配对结果视图：终端二维码 + 深链（任意键返回列表） */
function PairResultView({ r, onBack }: { r: PairResultView; onBack: () => void }): ReactElement {
  useInput(() => onBack())
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text color={theme.info} bold>
        {' '}
        配对已生成：{r.name}（{r.scope === 'full' ? '全功能' : '对话+只读'}）
      </Text>
      {!r.viaDaemon && <Text color={theme.warn}> ⚠ 离线形态（daemon 未在跑）——重启 serve 后生效，且无中继段</Text>}
      {r.link === undefined && r.viaDaemon && <Text color={theme.warn}> ⚠ 中继未连接——此配对仅限局域网；异地接入请中继在线后重新生成</Text>}
      {r.qrText !== '' ? (
        <Box flexDirection="column" marginTop={1}>
          {r.qrText.split('\n').map((line, i) => (
            <Text key={`qr${i}`}> {line}</Text>
          ))}
        </Box>
      ) : (
        <Text color={theme.warn}> （二维码不可用——用下方链接）</Text>
      )}
      {r.link !== undefined && (
        <Box marginTop={1}>
          <Text> 链接：{r.link}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor> 手机相机/微信扫码即自动配对 · 任意键返回列表</Text>
      </Box>
    </Box>
  )
}
