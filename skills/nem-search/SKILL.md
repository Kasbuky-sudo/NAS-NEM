---
name: nem-search
description: 在 NAS 端网易云音乐（NAS-NEM）搜索歌曲，返回可直接下载的曲目列表（含 songId、歌手、专辑、音质权限）。当用户想「找歌」「搜歌」「看看有没有某首歌」「在 NAS 网易云里找」时使用。找到后用 nem-download 下载。
---

# nem-search — NAS 网易云搜歌

## 连接参数

| 参数 | 取值 |
| --- | --- |
| Base URL | 环境变量 `NEM_AGENT_BASE` 优先；缺省 `http://<NAS_IP>:8163/agent` |
| Token | 环境变量 `NEM_AGENT_TOKEN` 优先；拿不到先跑 nem-status，里面写了 token 获取办法 |

⚠️ curl 访问内网必须加 `--noproxy '*'`（系统代理会劫持内网地址）。

## 请求

```bash
curl --noproxy '*' -s -G -H "Authorization: Bearer $NEM_AGENT_TOKEN" \
  http://<NAS_IP>:8163/agent/search \
  --data-urlencode "keyword=周杰伦 晴天" \
  --data-urlencode "limit=20"
```

- `keyword` 必填；`limit` 默认 20、最大 100；`offset` 翻页
- 关键词习惯：`歌手 歌名` 效果最好；纯歌名会混入大量翻唱

## 响应

```json
{
  "ok": true,
  "total": 246,
  "count": 20,
  "songs": [
    {
      "id": 2668397359,
      "name": "晴天 (原唱 周杰伦)",
      "artists": ["RyaVocal"],
      "album": "《晴天》",
      "durationMs": 269000,
      "fee": 0,
      "feeText": "free",
      "freeTrial": false
    }
  ]
}
```

## feeText 语义（决定能不能下到完整音源）

| feeText | 含义 | 匿名态下载结果 |
| --- | --- | --- |
| `free` | 免费歌 | **完整音源**（通常 320k mp3） |
| `vip` | VIP 专享 | 只有 30s 试听片段 |
| `album` | 数字专辑 | 通常只有试听 |

展示列表时把 feeText 一并报给用户（`[VIP]` / `[数字专辑]` / 免费不标注），
用户选了 VIP 歌要提前说明「当前匿名态只能下到试听片段」。

## 给用户的列表格式

```
1. 晴天 - 周杰伦 ｜ 专辑《叶惠美》 ｜ 4:29
2. 晴天 (原唱 周杰伦) - RyaVocal ｜ 4:29
...
```

用户说「下载第 N 首」时，取列表第 N 项的 `id` 交给 nem-download。

## 错误处理

| 现象 | 含义 | 对策 |
| --- | --- | --- |
| 401 | token 错/缺失 | 按 nem-status 的指引重新拿 token |
| 502 `search_failed` 且消息含 `-462` 或「绑定手机」 | 会话是空罐被风控 | 先跑 nem-status 看 `sessionPickedBy`；若是 `anonymous`，让用户在浏览器打开一次 NAS 网易云页面（产生匿名登录态）再试 |
| 连接失败 | 服务没起 | 走 nem-status 的自愈流程（trim-cli 重启应用） |
