# NAS-NEM —— 网易云音乐 NAS 版

把网易云音乐官方 PC 客户端跑在飞牛 fnOS NAS 上的**原生应用**（非 Docker）：
服务端解析官方乐库接口，浏览器 / fnOS 桌面里直接用完整播放器 ——
歌单、每日推荐、排行榜、歌词、二维码登录、在线播放、**歌曲下载到 NAS**，
还能让 AI 助手帮你找歌下载（Agent API）。

- **开发者**：[YUCLing](https://github.com/YUCLing)（上游 [open-orpheus](https://github.com/YUCLing/open-orpheus)，MIT）
- **NAS 移植 / 打包 / 发布**：[Kasbuky-sudo](https://github.com/Kasbuky-sudo)

## 功能

- 完整官方前端：首页推荐 / 歌单 / 排行榜 / 每日推荐 / 歌词 / 搜索
- 手机扫码登录（页内浮层，不再依赖原生窗口）
- 在线播放（`audioplayer.*` 完整桥接，HTML5 `<audio>` 出声）
- 歌曲下载，落地 NAS 用户根目录 `音乐` → `/vol1/1000/网易云音乐`
- 登录态跨设备共享：所有设备共用 NAS 上的一份登录态，一处扫码处处登录
  （需要每个浏览器独立登录态时，设 `NASNEM_MULTI_USER=true` 开启会话隔离）
- 弱网友好：静态资源 gzip 压缩（体积约降至 1/4）+ 缓存校验（ETag/304），
  首屏加载画面有进度提示 —— 飞牛 Connect 等远程访问不再长时间白屏
- Agent API：`/agent/*` 提供找歌 / 下载 / 状态查询，供 AI 助手自动化调用（见下文）
- 纯 Node.js，无沙箱无 Docker，复用应用中心的 Node.js v22

## 安装（飞牛 fnOS）

**方式一：FnDepot 应用源一键安装（推荐）**

应用中心 → 应用源 → 添加 [FnDepot](https://github.com/Kasbuky-sudo/FnDepot)，
搜索「网易云音乐」安装，后续升级也在应用中心里点一下即可。

**方式二：手动装包**

1. 应用中心先装 **Node.js v22**（`nodejs_v22`，本包声明了该依赖，通常会自动装）
2. 从 [Releases](../../releases) 下载 `NETEASE_CLOUD_MUSIC-<版本>.fpk`
3. 应用中心 → 手动安装 → 选择 fpk
4. 桌面出现「网易云音乐」图标，点开即用（端口 `8163`）

## AI 助手技能（Agent API）

应用内置 Agent API（Bearer token 鉴权），可以让 AI 助手直接帮你搜歌、下载：

```bash
# token 在 NAS 应用数据目录的 data/agent-token（0600）
curl -H "Authorization: Bearer <token>" http://<NAS_IP>:8163/agent/status
```

配套三个开箱即用的技能模板在 [`skills/`](skills/README.md)：
`nem-status`（探测服务与登录态）、`nem-search`（搜歌）、`nem-download`（下载到 NAS）。
导入 AI 助手后把 `<NAS_IP>` 换成你的 NAS 地址即可。

## 自己构建

```bash
# 1. 准备官方前端包（从官方安装器中提取 webfiles / resource）
node scripts/fetch-pack.js        # 需自备官方 pc 安装包，详见脚本头注释
# 2. 打 fpk（Windows 下需 Git Bash + fnpack）
bash packaging/fnOS/scripts/build.sh
```

产物：`packaging/fnOS/dist/NETEASE_CLOUD_MUSIC-<版本>.fpk`

## 目录结构

```
src/        服务端（桥接层 src/bridge、接口代理 src/proxy、前端改写 src/orpheus）
web/        注入官方前端的 shim.js（winhelper 窗口 / audioplayer 播放桥接 / 首屏加载画面）
skills/     Agent API 配套 AI 技能模板（nem-status / nem-search / nem-download）
packaging/  fnOS fpk 打包配置（manifest / cmd / ui / 构建脚本）
data/       前端资源目录（不入库）
```

## 已知限制

- 歌曲下载需先登录；会员 / 付费歌曲按账号自身权限处理，与官方客户端一致
- 下载目录：NAS 上默认 `/vol1/1000/网易云音乐`（装机回调自动创建并授权）。
  部分安装渠道不执行回调时该目录可能没建出来 —— 应用会自动退回应用数据目录
  `/vol1/@appdata/NETEASE_CLOUD_MUSIC/data/downloads`，手动补建即可回到预期位置：
  ```bash
  sudo mkdir -p "/vol1/1000/网易云音乐"
  sudo setfacl -m u:<应用用户>:x /vol1/1000
  sudo chown <应用用户>:<应用用户> "/vol1/1000/网易云音乐"
  ```
- Agent API 的匿名（未登录）能力有限：可搜索、可下载免费歌曲；VIP / 付费歌曲需先扫码登录，
  且按账号自身权限处理

## 许可

本项目代码 MIT（Kasbuky-sudo）；上游 open-orpheus MIT（YUCLing）。
