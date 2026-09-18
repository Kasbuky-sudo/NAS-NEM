---
name: nem-download
description: 通过 NAS-NEM Agent API 把歌下载到 NAS（飞牛 fnOS）的下载目录。当用户说「下载这首歌到 NAS」「把第 N 首下下来」「帮我把 XX 歌下到网易云下载目录」时使用。需要 songId（先用 nem-search 找歌）；支持查进度、取消任务。
---

# nem-download — NAS 网易云下载

## 连接参数

| 参数 | 取值 |
| --- | --- |
| Base URL | 环境变量 `NEM_AGENT_BASE` 优先；缺省 `http://<NAS_IP>:8163/agent` |
| Token | 环境变量 `NEM_AGENT_TOKEN` 优先；拿不到先跑 nem-status |

⚠️ curl 访问内网必须加 `--noproxy '*'`（系统代理会劫持内网地址）。

## 流程：提交 → 轮询 → 报告

### 1. 提交下载

只有 songId 就够了（服务端自动补歌名/歌手）：

```bash
curl --noproxy '*' -s -X POST \
  -H "Authorization: Bearer $NEM_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  http://<NAS_IP>:8163/agent/download \
  -d '{"songId": 2668397359}'
```

- `br` 可选：`128000` / `192000` / `320000`（默认）/ `999000`（无损，需登录 VIP 账号）
- 成功返回：`{"ok":true,"taskId":"agent-xxx","relativePath":"歌手 - 歌名.mp3","freeTrial":false,...}`
- **`freeTrial: true` = 只会下到试听片段**，立即告知用户并问是否继续（VIP 歌匿名态常态）；继续就不用管，任务会下完试听片段
- 同名文件自动 `(1)` 顺延，绝不覆盖已有歌

### 2. 轮询进度（建议 2 秒一次，多首歌可并行轮询）

```bash
curl --noproxy '*' -s -H "Authorization: Bearer $NEM_AGENT_TOKEN" \
  http://<NAS_IP>:8163/agent/download/agent-xxx
```

`task.state`：

| state | 含义 | 动作 |
| --- | --- | --- |
| `running` | 下载中 | 继续轮询；`progress.percent/speed` 可报给用户 |
| `done` | 完成 | 报告 `relativePath` + 大小（`progress.total` 换算 MB） |
| `failed` | 失败 | 读 `task.error` 原样报告 |
| `cancelled` | 已取消 | 说明即可 |

批量任务可用 `GET /agent/download/tasks` 一次看全部。

### 3. 取消（可选）

```bash
curl --noproxy '*' -s -X DELETE \
  -H "Authorization: Bearer $NEM_AGENT_TOKEN" \
  http://<NAS_IP>:8163/agent/download/agent-xxx
```

## 落盘位置

`GET /agent/status` 的 `downloadDir`（fnOS 上通常是 `/vol1/1000/网易云音乐`，
文件管理器里直接可见）。报告给用户时用 `relativePath`（相对下载目录）即可。

## 错误码速查

| HTTP | 含义 | 对策 |
| --- | --- | --- |
| 400 | 缺 songId / 请求体不是 JSON | 检查请求；`Content-Type: application/json` 别漏 |
| 401 | token 错/缺失 | 按 nem-status 指引拿 token |
| 404 | 任务不存在 | 任务太久被清理，重新提交 |
| 409 | 拿不到音源 URL | 看 body 的 `loggedIn`：`false` → 让用户扫码登录后重试；`true` → 该歌无版权或账号权限不足，换歌 |
| 429 | 并发任务已达上限 5 | 用 tasks 列表挑任务 DELETE 释放，或稍后重试 |
| 502 | 上游乐库接口错 | 消息里带 `-462` 时同 nem-search 的风控对策 |
