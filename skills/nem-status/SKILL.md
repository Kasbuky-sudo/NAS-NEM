---
name: nem-status
description: 探测 NAS 端网易云音乐（NAS-NEM 应用）服务与 Agent API 是否可用：版本、登录态、下载目录、任务概览。当用户问「NAS 网易云还在吗」「网易云服务什么状态」「下载怎么不动了」「网易云连不上」时使用。服务不通时给出用 trim-cli 自愈重启的路径。
---

# nem-status — NAS 网易云（NAS-NEM）服务探测

## 连接参数

| 参数 | 取值 |
| --- | --- |
| Base URL | 环境变量 `NEM_AGENT_BASE` 优先；缺省 `http://<NAS_IP>:8163/agent`（改成你 NAS 的内网地址） |
| Token | 环境变量 `NEM_AGENT_TOKEN` 优先；否则用 trim-cli 从 NAS 上读应用数据目录里的 `agent-token` 文件 |

⚠️ 本机配有系统代理，curl 访问 `192.168.x.x` 内网地址**必须加 `--noproxy '*'`**，
否则请求会被代理劫持到完全不相干的服务（表现为"内网服务返回了别人的页面"）。

## 步骤

### 1. 存活探测（免鉴权，先做这个）

```bash
curl --noproxy '*' -s http://<NAS_IP>:8163/agent/ping
```

正常返回：`{"ok":true,"agent":true,"version":"0.3.0","authRequired":true}`

不通（超时/拒绝连接）→ 服务没起，走自愈：

1. `trim-cli app list` 确认 `NETEASE_CLOUD_MUSIC` 的 status（命令用法见 trim-cli skill 的 trim-app 入口）
2. 非 start 则用 trim-cli 重启该应用（应用中心相关命令，写操作需要 `--yes`）
3. 等 5~10 秒复测 `/agent/ping`
4. 仍不通 → 用 trim-cli 看日志中心/应用日志，把报错原样报给用户

### 2. 带鉴权详情

```bash
curl --noproxy '*' -s -H "Authorization: Bearer $NEM_AGENT_TOKEN" \
  http://<NAS_IP>:8163/agent/status
```

返回字段：

| 字段 | 含义 |
| --- | --- |
| `version` | NAS-NEM 版本 |
| `loggedIn` | **false = 匿名态**：可搜索、可下免费歌完整音源；VIP 歌只有 30s 试听。提示用户在网页端扫码登录可解锁 VIP/无损 |
| `downloadDir` | 下载落盘根目录（fnOS 上通常是 `/vol1/1000/网易云音乐`） |
| `tasks` | `{running, known}`：running ≥ 5 时新下载会 429 |
| `sessionPickedBy` | 会话来源：`online`/`disk` = 已登录；`online-anon`/`disk-anon` = 匿名登录态（正常）；`anonymous` = 空罐兜底，**搜索可能被 -462 风控拒**，让用户先在网页端打开一次应用 |

### 3. token 拿不到时

token 文件在 NAS 应用数据目录的 `data/agent-token`（0600）。用 trim-cli 的文件能力
按 `agent-token` 关键字在 `/vol1/@appdata` 下定位后读取；仍找不到就如实告诉用户
「需要在 NAS 上拿 agent-token 文件内容」，不要编造 token。

## 输出约定

给用户的结论至少包含：服务通不通、版本、登录态（匿名/已登录及能力边界）、
当前下载任务数。探测到异常时先给一句结论，再给修复动作。
