# ECode relay 自部署指南

> 状态：**已完成（R2/R3 交付随附）**
> 读者：想在自己 VPS 上跑 relay（异地手机接入自家电脑 ECode）的用户。
> 前置认知：relay 是「中继转发器」——手机与电脑之间的公网信箱。它**只转发加密信封**，看不到对话内容（E2EE）；它**不存任何数据**，skill/MCP/会话数据全部在电脑本地。
> 实例部署：nodetime.cn（2C2G 阿里云，部署格式对照 RAG systemd 单元——2026-09-01 实施记录见文末）。

## 1. 架构与端口约定

```
手机/PWA ──https(443)── nginx ──┬── /ecode/        → relay 手机段 127.0.0.1:7091（PWA 静态壳 + WS 数据腿 + 在线查询）
                                └── /ecode-tunnel/ → relay 电脑段 127.0.0.1:7092（daemon 控制腿/数据腿接入）
电脑 daemon ──出站 WS────┘（纯出站，电脑侧零入站端口）
```

- **安全组只开 443**（80 仅跳转）；7091/7092 绑 127.0.0.1 不对外——同 RAG 4000 端口的既有纪律。
- relay 依赖仅 `ws` 一个 npm 包（Node ≥18，与 ECode 主程序同机即可，也可独立 VPS）。

## 2. relay 服务端部署

### 2.1 文件就位（服务器零编译——本地组装 tar 上传）

```bash
# 本地（ECode 仓库根）
mkdir -p /tmp/ecode-relay/node_modules
cp relay/server.cjs /tmp/ecode-relay/
cp -r node_modules/ws /tmp/ecode-relay/node_modules/        # ws 及其依赖极简
cd /tmp && tar czf ecode-relay.tar.gz ecode-relay
scp /tmp/ecode-relay.tar.gz admin@<服务器>:/tmp/

# 服务器
mkdir -p ~/workspace/02_apps/ecode-relay
tar xzf /tmp/ecode-relay.tar.gz -C ~/workspace/02_apps/     # 解压即部署
```

PWA 静态壳（手机浏览器打开的页面）：本地 `web/` 目录 `npm run build` 后，把 `web/dist` 一并上传，路径记入环境变量 `RELAY_WEB_DIR`（不配则 relay 只提供 API/WS，手机壳需另找来源——不推荐）。

### 2.2 systemd 单元（格式对照 `rag-docs-assistant.service`）

`/etc/systemd/system/ecode-relay.service`：

```ini
[Unit]
Description=ECode Relay (messaging relay, ciphertext-only)
After=network.target

[Service]
Type=simple
User=admin
WorkingDirectory=/home/admin/workspace/02_apps/ecode-relay
ExecStart=/home/admin/.nvm/versions/node/v22.23.1/bin/node server.cjs
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=RELAY_REG_TOKEN=<openssl rand -hex 16 生成>
Environment=RELAY_PHONE_PORT=7091
Environment=RELAY_HOST_PORT=7092
Environment=RELAY_WEB_DIR=/home/admin/workspace/02_apps/ecode-relay/web-dist
Environment=RELAY_PUBLIC_CONNECT_BASE=wss://nodetime.cn/ecode
Environment=RELAY_LOG=/home/admin/workspace/02_apps/ecode-relay/relay.log

[Install]
WantedBy=multi-user.target
```

> ExecStart 的 node 路径按机器实际：`which node`（本实例 /usr/bin/node 不存在，用 nvm 路径）。
> 启停：`sudo systemctl enable --now ecode-relay` / `restart` / `journalctl -u ecode-relay -n 50`。

### 2.3 nginx 路由（`01_nginx/conf.d/nodetime.cn.conf` 追加 location）

```nginx
# 手机段（PWA 壳 + WS 数据腿）——WS 升级头必须有，否则 /v1/connect 握手失败
location /ecode/ {
    proxy_pass http://127.0.0.1:7091/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}
# 电脑段（daemon 控制腿/数据腿）
location /ecode-tunnel/ {
    proxy_pass http://127.0.0.1:7092/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}
```

改完 `docker exec ng_edge nginx -t && docker exec ng_edge nginx -s reload`（既有流程）。

## 3. 电脑侧接入（ECode）

`~/.ecode/config.json` 追加：

```jsonc
"relay": {
  "server": "wss://nodetime.cn",   // relay 源；电脑段路径默认 server + /ecode-tunnel
  "hostToken": "<RELAY_REG_TOKEN>", // 与 relay 单元里一致——电脑段准入凭据
  "hostId": "office-pc",            // 本机登记名（多机区分；缺省主机名）
  "name": "公司电脑"                 // 手机上显示的别名（可选）
}
```

重启 daemon：`ecode serve stop && ecode serve`（或直接 `ecode`——附着既有 daemon 需重启一次让 relay 配置生效）。日志出现 `relay_control_up` 即控制腿在位。

## 4. 配对与手机接入

1. 电脑端：`ecode pair 手机` → 终端出二维码/链接（`https://<relay>/ecode/#pairing=<...>`，fragment 承载不进代理日志）+ per-device 令牌；
2. 手机：微信/相机扫码 → 浏览器打开 → 自动完成配对（令牌+中继参数+钉公钥落 localStorage）→ 直接进对话；
3. 安全属性：per-device 令牌可单独吊销（`ecode devices revoke` 或 web 设备面板）；E2EE 由 offer 钉住的 daemon 公钥保障（中继换钥即被识破）；invite 持久有效、吊销即断。
4. 多机：每台电脑各自 `ecode pair` → 手机的「设备」面板列出全部已配对主机（在线徽标/点按切换）。

## 5. 环境变量速查（relay server.cjs）

| 变量 | 缺省 | 说明 |
|---|---|---|
| `RELAY_REG_TOKEN` | 空=拒绝接入 | 电脑段准入（必配） |
| `RELAY_PHONE_PORT` / `RELAY_HOST_PORT` | 7091 / 7092 | 手机段 / 电脑段监听（均绑 127.0.0.1） |
| `RELAY_WEB_DIR` | 空=不托管 | PWA 静态壳目录 |
| `RELAY_PUBLIC_CONNECT_BASE` | 空 | offer 里的手机接入基址（如 `wss://nodetime.cn/ecode`） |
| `RELAY_LEASE_MS` / `RELAY_PING_MS` / `RELAY_SILENCE_MS` | 120s / 15s / 75s | 租约/ping/静默踢（orca 实测值，勿乱调） |
| `RELAY_ATTACH_MS` | 60s | conn-open 后 daemon 拨数据腿时限（超时手机收 4408） |
| `RELAY_LOG` | relay.log | 运行日志 |

## 6. 健康检查与排障

```bash
curl -s https://nodetime.cn/ecode/v1/health                        # {"ok":true,"hosts":N}
curl -s -X POST https://nodetime.cn/ecode-tunnel/v1/assign \
     -H "Authorization: Bearer <REG_TOKEN>"                        # director 契约回显
curl -s "https://nodetime.cn/ecode/v1/hosts/online?ids=office-pc"  # 多机在线徽标
```

| 症状 | 排查 |
|---|---|
| daemon 日志无 relay_control_up | config.relay 拼写/hostToken 不一致；`journalctl -u ecode-relay` 看 4401 |
| 反复 `relay_control_down (1006)` | nginx 该 location 缺 WS 升级头，或 `proxy_read_timeout` 太短 |
| 手机「设备连接已失效」 | invite/令牌被吊销或 relay 侧无此主机——重新 `ecode pair` |
| 手机连上但打不开项目 | 配对快照里没有该项目——重新 pair（device 凭据不枚举项目是有意栅栏） |
| 浏览器报 X25519 不支持 | 换 Chrome 133+/Safari 18.4+（E2EE 强制，无降级） |

## 7. 威胁模型边界（自部署形态即运营方）

- relay 只见：谁连谁、代次/租约、帧大小与时序；**不见**：任何对话内容与设备令牌（e2ee_auth 起全密文）。
- 明文窗口：仅握手两个密钥交换帧（`e2ee_hello`/`e2ee_ready`）——只含临时公钥与随机 nonce，无凭据。
- TLS 终止在 nginx（Let's Encrypt）；REG_TOKEN 常量时比较；invite 可吊销即断活连接。
- relay 进程被攻破的最大损失 = 拒绝服务（转发面瘫痪），不构成内容泄露面。
- 已知边界（披露）：①PWA 代码由 relay 源下发——恶意 relay 理论上可改 JS（读本机 localStorage）；自部署形态「用户即运营方」自洽，若需彻底闭合应从 daemon 直连首次加载并校验资产指纹；②`#pairing` 深链的 connectUrl 由链接构造者指定——只扫可信来源（电脑端 `ecode pair` 现场出码）的二维码；③hostId 缺省为主机名可被字典枚举（在线查询只回显 name/version，无凭据面；介意可在 config.relay.hostId 配高熵名）。

---

## 实施记录（nodetime.cn 实例，2026-09-01）

- 目录 `~/workspace/02_apps/ecode-relay/`（server.cjs + node_modules/ws + web-dist/）；单元 `ecode-relay.service` 按上节格式（ExecStart 用 nvm node `/home/admin/.nvm/versions/node/v22.23.1/bin/node`——`/usr/bin/node` 在本机不存在）。
- 端口 7091/7092 沿用 T 线最小隧道时代的既有单元与 nginx location（`/ecode/`、`/ecode-tunnel/`），本次补齐 WS 升级头与 `RELAY_WEB_DIR`。
- 电脑侧：`~/.ecode/config.json` 写 `relay` 段（REG_TOKEN 取自单元 Environment）→ `ecode serve stop && ecode serve` → 日志 `relay_control_up`；`ecode pair` 出带 relay 段的二维码 offer。
- 外网探针：`npx tsx scripts/relay-e2e-probe.ts --server wss://nodetime.cn --token <REG_TOKEN>`（自机经公网全链路 6 断言：控制腿/offer relay 段+钉公钥/E2EE 握手/cmd 往返/事件透传/rebind 自愈）。
