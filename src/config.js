/**
 * NAS-NEM 配置
 *
 * 全部通过环境变量覆盖，默认值面向 Docker 部署（数据落 /data）。
 * 本机开发时若不设 NASNEM_DATA，则用项目下的 ./data。
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function envInt(name, fallback) {
  const v = Number.parseInt(env(name, ""), 10);
  return Number.isFinite(v) ? v : fallback;
}

function envBool(name, fallback) {
  const v = env(name, "");
  if (v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function envPath(name, fallback) {
  const v = env(name, fallback);
  return isAbsolute(v) ? v : resolve(ROOT, v);
}

/** 官方客户端包地址。默认锁到 open-orpheus 记录的可用版本。 */
const PACK_VERSION = env("NASNEM_PACK_VERSION", "3.1.34.205281");
const PACK_URL = env(
  "NASNEM_PACK_URL",
  `https://d8.music.126.net/dmusic2/NeteaseCloudMusic_Music_official_${PACK_VERSION}_32.exe`
);

const DATA_DIR = envPath("NASNEM_DATA", "data");

/**
 * 下载音乐落地目录。
 * 留空则自动判定：存在 /vol1/1000（飞牛 fnOS 用户根目录）→ /vol1/1000/网易云音乐；
 * 否则退回 DATA_DIR/downloads（本机开发 / Docker）。
 */
const DOWNLOAD_DIR = env("NASNEM_DOWNLOAD_DIR", "");

/** 解析最终的下载落地目录（结果会缓存，见 calls/download.js） */
export function resolveDownloadDir() {
  if (DOWNLOAD_DIR) return DOWNLOAD_DIR;
  if (existsSync("/vol1/1000")) return "/vol1/1000/网易云音乐";
  return resolve(DATA_DIR, "downloads");
}

/**
 * 前端资源目录。
 *
 * ⚠️ 这两个目录**不一定**在 DATA_DIR 里 —— 飞牛原生包的布局是：
 *     只读代码 + 官方前端  →  ${TRIM_APPDEST}/data/{webfiles,resource}（升级整体覆盖）
 *     可写用户数据        →  ${TRIM_PKGVAR}/data（登录态、缓存，卸载保留）
 * 所以必须用独立的环境变量指过去（cmd/main 里注入），
 * 只靠 DATA_DIR 推导会指向一个空目录。
 *
 * 注意 docker / 本机开发两种形态都没设这两个变量，因此默认值保持
 * DATA_DIR 下的相对布局，行为不变。
 */
const WEBFILES_DIR = envPath("NASNEM_WEBFILES", resolve(DATA_DIR, "webfiles"));
const RESOURCE_DIR = envPath("NASNEM_RESOURCE", resolve(DATA_DIR, "resource"));

/** 数据目录布局 */
export const paths = {
  /** 根目录别名（router / 静态服务里最常用） */
  dataDir: DATA_DIR,
  data: DATA_DIR,
  package: resolve(DATA_DIR, "package"),
  /** orpheus.ntpk 解出来的前端静态文件（pub/…）。可用 NASNEM_WEBFILES 单独指定 */
  webfiles: WEBFILES_DIR,
  /** 官方 resource/（皮肤、format.ico 等）。可用 NASNEM_RESOURCE 单独指定 */
  resource: RESOURCE_DIR,
  storage: resolve(DATA_DIR, "storage"),
  wasm: resolve(DATA_DIR, "wasm"),
  cache: resolve(DATA_DIR, "cache"),
  logs: resolve(DATA_DIR, "logs"),
  users: resolve(DATA_DIR, "users"),
  downloadTemp: resolve(DATA_DIR, "download-temp"),
  streamTemp: resolve(DATA_DIR, "stream-temp"),
};

export const config = {
  /** HTTP 端口，NAS 场景默认 8163 */
  port: envInt("NASNEM_PORT", 8163),
  host: env("NASNEM_HOST", "0.0.0.0"),

  dataDir: DATA_DIR,
  pack: { url: PACK_URL, version: PACK_VERSION },

  /**
   * 本地音乐库目录（NAS 上的音乐文件夹），逗号分隔。
   * 留空则关闭本地曲库扫描。
   */
  musicDirs: env("NASNEM_MUSIC_DIRS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => (isAbsolute(p) ? p : resolve(ROOT, p))),

  logLevel: env("NASNEM_LOG_LEVEL", "info"),

  /** 反代后面部署时，用 X-Forwarded-Proto 判定 https */
  trustProxy: envBool("NASNEM_TRUST_PROXY", true),

  /**
   * 单机多用户：每个浏览器会话拿到独立的数据空间（cookie / 曲库 / 缓存）。
   * 关闭则所有访问者共用一份（单用户 NAS 可以关）。
   */
  multiUser: envBool("NASNEM_MULTI_USER", true),

  /** 上游请求超时（毫秒） */
  requestTimeout: envInt("NASNEM_REQUEST_TIMEOUT", 30_000),

  /**
   * 覆盖伪设备号（32 位 hex）。留空则用 `data/deviceid`，首次自动生成。
   *
   * 设备号在网易那边就是**匿名账号主键**，而新建匿名账号是按 IP 限流的
   * （见 src/bridge/calls/os.js 的说明）。所以它必须跨会话稳定，
   * 想换身份时才用这个变量。
   */
  deviceId: env("NASNEM_DEVICE_ID", ""),

  /**
   * 调试：把代理层看到的 eapi 响应**解密后**写成 JSONL。
   * 排查"页面空白但零报错"这类问题时，这是唯一能看到全部接口明文的手段。
   */
  dumpApi: env("NASNEM_DUMP_API", ""),

  /**
   * 调试：往官方 bundle 里注入首页加载链路的探针。
   *
   * 首页推荐区块由 `page:homePage` 模型的 `fetchBlocksData` effect 拉取，
   * 而它的第一步是一道"静默闸门"：
   *     const e = yield a(n.j);
   *     if (!e) return;          // ← 这里退出既不抛错也不打日志
   * 表现为"页面主体空白、控制台干净"，光靠抓包**分不清**是"没发起"还是"被闸门挡了"。
   * 打开这个开关后 bundle 会在 19.chunk 里插两行 console.log，
   * 明确告诉你 effect 有没有被 dispatch、闸门值是多少。
   */
  debugHomepage: envBool("NASNEM_DEBUG_HOMEPAGE", false),

  /**
   * 逐请求打印反代的"进 / 出"字节数。
   *
   * 排查过的一个症状：上游明明回了 4208B（dump 里记着），Node 直接 fetch
   * 同一个 URL 也能拿到 4199B，但**浏览器侧 CDP 看到的 body 恒为 0**
   * （status 又是 200，所以前端一声不吭）。这种"两边都对、中间没了"的案子，
   * 必须在代理里数清"我到底往 socket 写了多少字节"，否则全是猜。
   */
  debugProxy: envBool("NASNEM_DEBUG_PROXY", false),

  /** 音频流分块大小 */
  audioChunkSize: envInt("NASNEM_AUDIO_CHUNK", 256 * 1024),

  /** 允许的官方接口域名（防 SSRF）。后缀匹配，写 `163.com` 即覆盖 `interface.music.163.com` */
  allowedApiHosts: env(
    "NASNEM_ALLOWED_HOSTS",
    "163.com,126.net,netease.com,163yun.com,127.net"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

/**
 * 确保所有**可写**数据目录存在。
 *
 * ⚠️ webfiles / resource 必须排除在外：飞牛原生包把它们放在只读的
 * ${TRIM_APPDEST} 下（升级会整体覆盖），在只读文件系统上 mkdir 会抛
 * EACCES 直接把启动打断；就算可写也没意义 —— 它们是随包发布的资源，
 * 不是运行期要生成的目录。
 */
export function ensureDirs() {
  const READ_ONLY = new Set([paths.webfiles, paths.resource]);
  for (const dir of Object.values(paths)) {
    if (READ_ONLY.has(dir)) continue;
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch (e) {
      // 只读挂载或权限不足时不要炸掉整个启动：真正需要的目录由 cmd/main
      // 在 ${TRIM_PKGVAR} 下建好，这里失败只影响调试用的临时目录
      if (!dir.startsWith(DATA_DIR)) throw e;
    }
  }
}

export default config;
