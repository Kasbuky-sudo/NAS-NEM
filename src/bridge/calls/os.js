/**
 * os.* —— 设备与系统信息
 * =========================
 * 官方前端靠 `os.getDeviceId` / `os.getADDeviceID` 拿设备指纹（登录、加密头里都要），
 * 靠 `os.getSystemInfo` / `os.getAllDisplayInfo` 拿屏幕信息做歌词与迷你窗布局。
 * 这些在浏览器里可以本地答（见 web/shim.js），但服务端也要有一份：
 * 子窗口 / 首次连接时未必命中本地表，而且 deviceId 必须**跨会话稳定**，
 * 本地随机出来的每次刷新都变，会导致加密头对不上。
 *
 * ⚠️ 返回值形状是踩过坑的，别凭直觉改：
 *
 *   dispatcher 的约定是「handler 返回数组 → 展开成回调参数」，
 *   而 SDK 侧 `OrpheusCommand.call` 的约定是
 *        0 个回调参数 → resolve(undefined)
 *        1 个          → resolve(args[0])
 *        ≥2 个         → resolve(args)
 *   所以「要返回一个对象/数组」必须写成 `return [obj]`，
 *   一旦顺手 `JSON.stringify` 了，前端拿到的就是字符串：
 *    `"[]".filter` / `"[]".forEach` 当场 TypeError（白屏），
 *    `"{}".workArea` 也是 undefined。这三个坑都真真切切炸过。
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { hostname, arch, cpus, totalmem, release } from "node:os";
import { join } from "node:path";

import { paths, default as config } from "../../config.js";
import { randomId, clientPath } from "../../util.js";

const DEVICE_ID_RE = /^[0-9a-f]{16,64}$/i;

/** 读一个合法的 deviceId 文本文件，不合法/不存在返回 null */
function readDeviceId(file) {
  try {
    if (!existsSync(file)) return null;
    const v = readFileSync(file, "utf8").trim();
    return DEVICE_ID_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * 取一个**跨会话稳定**的伪设备号（32 位 hex，形态与官方的 clientSign 一致）。
 *
 * ⚠️ 为什么必须稳定、而且必须放在**根数据目录**而不是每会话目录：
 *
 *   网易的匿名登录 `/api/register/anonimous` 是**按 IP 限流新建账号**的。
 *   设备号在服务端就是账号主键 —— 已经注册过的设备号再调一次会 200 并返回
 *   原账号（幂等），而一个从没见过的设备号在限流生效时只会拿到 `{"code":400}`。
 *
 *   之前按 sid 存放，等于**每开一个浏览器会话就烧掉一次新账号注册**：
 *   刷几次页面就被风控按住，表现是"未登录 → 首页数据加载失败"，
 *   而日志里干干净净（400 是正常 HTTP 200 里的业务码，不报错）。
 *
 *   设备指纹本来就该是"一台机器一个"，所以落 `data/deviceid`：
 *   NAS 上所有用户/所有会话共用一个匿名身份，既符合语义也省限额。
 *
 * 需要用别的身份时用 `NASNEM_DEVICE_ID` 覆盖（调试 / 多实例）。
 */
function resolveDeviceId() {
  const fromEnv = (config.deviceId || "").trim();
  if (fromEnv && DEVICE_ID_RE.test(fromEnv)) return fromEnv;

  const file = join(paths.dataDir, "deviceid");
  const existing = readDeviceId(file);
  if (existing) return existing;

  const id = randomId(16);
  writeFile(file, id, "utf8").catch(() => {});
  return id;
}

/** 虚拟屏幕参数：浏览器里没有"物理显示器"，给一套固定的合理值 */
const SCREEN = { x: 0, y: 0, width: 1920, height: 1080, workWidth: 1920, workHeight: 1050 };

export function makeOsCalls(ctx) {
  const deviceId = resolveDeviceId();
  const osVer = `${release()}`;
  const started = Date.now();

  /**
   * ⚠️ `os.queryOsVer` 必须回一个「不像 macOS 10.13 及更早」的版本号。
   *
   * app.chunk 里有个 OSX 版本闸门（"isLowerOSX*" 那批函数）：
   *     const g = () => (0 !== d || 0 !== f || 0 !== p) && (d <= 10 && f < 14)   // isLowerOSX10_14
   * d/f/p 来自 `Os.queryOsVer()` 按 "major.minor.patch" 解析出来的三个数。
   *
   * 而 `g` 是这批里**唯一漏写 `isOSX &&` 前缀**的（官方自己的疏漏），
   * 于是它拿 macOS 的尺子量了所有平台：
   *     本机 release() = "10.0.19045" → d=10, f=0  → 判定「系统过低」
   *     Linux "6.8.0-31-generic"     → d=6        → 一样中招
   * 后果见 SubAppContent：
   *     if (isMainWindow && isLowerOSX10_14()) return <Il><Fl /></Il>;
   * 整页只剩一张 lowOSXVersionBlank.png —— 就是那个 192 字符的"白屏"。
   *
   * 这里回一个 macOS 14，故意落在 (10, 15) 开区间：
   *   g() → 需要 d<=10，14 不成立 → false
   *   O() → isLowerOSx10_15_1 需要 d<=10   → false
   *   C() → isUpperOSx15_2   需要 d>=15   → false（保守，不额外点亮新特性）
   * 其余 isLowerOSX14/13/12/11/10 都带 `isOSX &&`，本来就是 false，不受影响。
   *
   * 只管这道闸门的返回值；deviceInfo.osver 仍旧如实上报真实内核版本。
   */
  const OSX_GATE_SAFE_VERSION = "14.7.0";

  const baseInfo = {
    platform: "win32",
    os: "pc",
    osver: osVer,
    hostname: hostname(),
    arch: arch(),
    cpus: cpus().length,
    totalmem,
    macAddress: "",
    deviceId,
    clientSign: deviceId,
  };

  /**
   * `os.getSystemInfo` 的官方形状（bundle 里的兜底常量就是它）：
   *   {factor, monitor:{x,y,width,height}, monitorName, workArea:{x,y,width,height}}
   * 前端在 `configWindowPosition` 里直接取 `.workArea.width/height` 来夹窗口尺寸。
   */
  const systemInfo = () => ({
    factor: 1,
    monitor: { x: SCREEN.x, y: SCREEN.y, width: SCREEN.width, height: SCREEN.height },
    monitorName: "虚拟显示器",
    workArea: { x: SCREEN.x, y: SCREEN.y, width: SCREEN.workWidth, height: SCREEN.workHeight },
    ...baseInfo,
  });

  /**
   * `os.getAllDisplayInfo` 必须 resolve 出一个**真数组**：
   * 前端 `t.forEach(e => {e.isPrimary ? ... })` + `t.some(e => e.deviceId === o)`。
   */
  const displays = () => [
    {
      ...SCREEN,
      scale: 1,
      factor: 1,
      deviceId: "primary",
      name: "虚拟显示器 1",
      monitorName: "虚拟显示器 1",
      isPrimary: true,
      isVirtual: true,
      workArea: { x: SCREEN.x, y: SCREEN.y, width: SCREEN.workWidth, height: SCREEN.workHeight },
    },
  ];

  return {
    /* ─── 设备指纹 ─── */
    "os.getDeviceId": () => [deviceId],
    "os.getADDeviceID": () => [deviceId],

    /**
     * `os.getDeviceInfo` 走的是 overwriteRegisterCall，属于"事件型"：
     * SDK 注册 `os.onGetDeviceInfo` 后调这个命令，结果只能用事件推回去。
     * 这里同步推一次；不推的话前端的 Promise 会永久 pending。
     */
    "os.getDeviceInfo": () => {
      const info = { ...baseInfo, uptime: Math.floor((Date.now() - started) / 1000) };
      ctx.emit("os.onGetDeviceInfo", [info]);
      return [];
    },

    /* ─── 屏幕信息 ─── */
    "os.getSystemInfo": () => [systemInfo()],
    "os.getAllDisplayInfo": () => [displays()],

    /* ─── 系统杂项 ─── */
    /** 见文件上方 OSX_GATE_SAFE_VERSION：给「系统版本过低」白屏闸门用的安全值 */
    "os.queryOsVer": () => [OSX_GATE_SAFE_VERSION],
    "os.querySystemFonts": () => ["success", []],
    "os.checkNativeSupportFonts": () => ["success", []],
    "os.isOnLine": () => [true],
    "os.isSystemDarkThemeEnabled": () => [false],
    "os.checkSystemDarkThemeEnabled": () => [false],
    "os.isFileExist": (p) => {
      try {
        return [existsSync(clientPath(ctx.dataDir, p, "abs"))];
      } catch {
        return [false];
      }
    },
    /** 官方回调收到的是**JSON 字符串**：`JSON.parse(e).free` —— 不要自作聪明给对象 */
    "os.getDiskSpace": () => [JSON.stringify({ free: 512 * 1024 * 1024 * 1024, total: 1024 * 1024 * 1024 * 1024 })],
    "os.exitWindowSystem": () => [],
    "os.exitWindowSystemLeftTime": () => [0],
    "os.setPowerRequests": () => [],
    "os.callSystemAppWithParam": () => [false],
    "os.shellOpen": () => [true],
    "os.shellExplor": () => [true],
    "os.navigateExternal": (url) => {
      // 服务端只做记录；真正打开新标签页由前端 shim 处理
      ctx.emit("app.onNavigateExternal", [String(url ?? "")]);
      return [true];
    },
  };
}

export default makeOsCalls;
