# NAS-NEM Agent API 配套 Skills

给 AI 助手（如 WorkBuddy）用的自动化技能：搜歌、下载、查状态。
接口走 NAS-NEM 应用的 Agent API（`/agent/*`，Bearer token 鉴权）。

## 使用前

1. **把 SKILL.md 里的 `<NAS_IP>` 换成你 NAS 的内网 IP**
   （或设置环境变量 `NEM_AGENT_BASE=http://<NAS_IP>:8163/agent`，优先级更高）；
2. Token 来源：环境变量 `NEM_AGENT_TOKEN`，或从 NAS 应用数据目录读
   `data/agent-token` 文件（0600，只有应用和 root 能读）。

## 技能清单

| 技能 | 用途 |
|---|---|
| `nem-status` | 探测应用服务与登录态是否可用 |
| `nem-search` | 搜歌，返回可直接下载的曲目列表 |
| `nem-download` | 把指定歌曲下载到 NAS 下载目录，支持查进度 |

## 隐私说明

本目录所有文件均为**脱敏模板**（无内网 IP、无凭据），可随仓库分发。
各人自用的本地副本请自行维护，勿把真实 IP / token 提交回来。
