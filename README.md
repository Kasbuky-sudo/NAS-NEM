# NAS-NEM —— 网易云音乐 NAS 版

把网易云音乐官方 PC 客户端跑在飞牛 fnOS NAS 上的**原生应用**（非 Docker）：
服务端解析官方乐库接口，浏览器 / fnOS 桌面里直接用完整播放器 ——
歌单、每日推荐、排行榜、歌词、二维码登录、在线播放、**歌曲下载到 NAS**。

> 上游项目 [open-orpheus](https://github.com/YUCLing/open-orpheus)（MIT，YUCLing）。
> 本仓库是其 NAS 侧移植与 fnOS 打包（by Kasbuky-sudo）。

## 功能

- 完整官方前端：首页推荐 / 歌单 / 排行榜 / 每日推荐 / 歌词 / 搜索
- 手机扫码登录（页内浮层，不再依赖原生窗口）
- 在线播放（`audioplayer.*` 完整桥接，HTML5 `<audio>` 出声）
- 歌曲下载，落地 NAS 用户根目录 `音乐` → `/vol1/1000/网易云音乐`
- 多浏览器会话隔离（每会话独立登录态 / 曲库），单用户 NAS 可关
- 纯 Node.js，无沙箱无 Docker，复用应用中心的 Node.js v22

## 安装（飞牛 fnOS）

1. 应用中心先装 **Node.js v22**（`nodejs_v22`，本包声明了该依赖，通常会自动装）
2. 从 [Releases](../../releases) 下载 `NETEASE_CLOUD_MUSIC-<版本>.fpk`
3. 应用中心 → 手动安装 → 选择 fpk
4. 桌面出现「网易云音乐」图标，点开即用（端口 `8163`）

> 需要 FnDepot 应用源一键安装的，见 [FnDepot 收录](../../releases) 说明。

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
web/        注入官方前端的 shim.js（winhelper 窗口 / audioplayer 播放桥接）
packaging/  fnOS fpk 打包配置（manifest / cmd / ui / 构建脚本）
data/       官方前端资源（不入库，构建时准备）
```

## 已知限制

- 下载需先登录；VIP / 版权歌曲遵循账号权限，与官方客户端一致
- 官方前端资源（`data/webfiles`）版权归网易，仅个人学习研究用途，
  请勿用于商业用途

## 许可

本项目代码 MIT；上游 open-orpheus MIT。官方前端资源不属于本项目许可范围。
