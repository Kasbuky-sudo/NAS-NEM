/**
 * NAS-NEM 服务入口
 * ==================
 * 一个进程干四件事：
 *
 *   1. `/__shim.js`     —— 注入到官方前端的桥 + URL 改写脚本
 *   2. `/orpheus/*`     —— 把 `orpheus://` 那套宿主端点映射成 HTTP
 *   3. `/pub/*` 等静态 —— 官方前端文件，走改写层（isMainWindow / CSP / shim）
 *   4. `/__p/<host>/*`  —— 同源反向代理，替前端绕开 CORS 并托管 cookie
 *   +
 *   `/__bridge`         —— WebSocket，顶替 CEF 注入的 window.channel
 *
 * 端口默认 8163（NASNEM_PORT 覆盖），监听 0.0.0.0，方便 Docker / 局域网直连。
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { gzip as gzipCb } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzipCb);

// ⚠️ 这个 import 必须排在所有第三方依赖之前。
// 它把应用自带的 node_modules（以及应用中心 nodejs_v22 的 node_modules）
// 挂进模块解析路径，之后 express / ws / tough-cookie 才找得到。
// 依赖图：node-runtime.js 只 import node: 内置模块，不 import 任何第三方包，
// 所以它一定先于 express 被求值 —— 这个顺序是有保证的，不是碰运气。
import { installRuntimeResolution } from "./node-runtime.js";

const runtime = installRuntimeResolution();

import express from "express";

import config, { paths, ensureDirs, ROOT } from "./config.js";
import createLogger from "./logger.js";
import { safeJoin, randomId } from "./util.js";
import handleOrpheus, { mimeOf } from "./orpheus/router.js";
import {
  readAndRewrite,
  transformable,
  verifyPatch,
  loadShim,
  FRAME_ANCESTORS,
} from "./orpheus/rewrite.js";
import { handleProxy, handleCache } from "./proxy/frontend.js";
import { attachBridge, sessionCount } from "./bridge/server.js";
import { mountAgent } from "./agent/server.js";

const log = createLogger("main");

/* ─────────────────────────── 进程级兜底 ───────────────────────────
 * NAS 应用宁可带病运行，也不能静默消失。流错误类异常（pipe 两端的
 * 'error'、AbortSignal 砍流、第三方库漏接的 reject）一旦漏接就是
 * uncaughtException / unhandledRejection，默认行为是进程退出 ——
 * 应用中心里就是"应用自己停了"，必须手动再启动（两台 NAS 都实录过）。
 * 这里接住只记日志不退出；请求级的错误已在各 handler 内消化。
 */
process.on("unhandledRejection", (reason) => {
  log.error(`unhandledRejection（兜底，进程继续）: ${reason?.stack || reason}`);
});
process.on("uncaughtException", (err) => {
  log.error(`uncaughtException（兜底，进程继续）: ${err?.stack || err}`);
});

const SID_COOKIE = "nas_sid";

/* ─────────────────────────── 会话 Cookie ─────────────────────────── */

function sidMiddleware(req, res, next) {
  const raw = req.headers.cookie || "";
  const m = /(?:^|;\s*)nas_sid=([^;]+)/.exec(raw);
  if (!m || !/^[A-Za-z0-9_-]{4,64}$/.test(decodeURIComponent(m[1]))) {
    const sid = randomId(12);
    const parts = [`${SID_COOKIE}=${sid}`, "Path=/", "Max-Age=31536000", "SameSite=Lax"];
    const prev = res.getHeader("Set-Cookie");
    const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
    list.push(parts.join("; "));
    res.setHeader("Set-Cookie", list);
    req.headers.cookie = raw ? `${raw}; ${SID_COOKIE}=${sid}` : `${SID_COOKIE}=${sid}`;
  }
  next();
}

/* ─────────────────────────── 静态前端 ─────────────────────────── */

/* gzip 支持 ────────────────────────────────────────────────────────
 * 飞牛 Connect 等远程中继走的是家庭宽带上行（常在 1~30Mbps 且不稳），
 * 官方前端的 app/subApp 主 chunk 各约 5MB、CSS 各约 3.5MB，之前全部
 * 明文传输：弱网下首屏要拉十几 MB，表现为"网页白屏"；点登录再拉
 * subApp 的 8MB+，表现为"登录页出不来"。gzip 对 JS/CSS 有 3~4 倍压缩比，
 * 是弱网体验的最大单项改善。
 * 压缩结果按 (路径|mtime|size) 缓存在内存里，每个文件只压一次；
 * 用异步 gzip 不阻塞事件循环。图片/字体/wasm 等已压缩格式不参与。 */
const COMPRESSIBLE_EXT = new Set([
  ".js", ".mjs", ".css", ".html", ".htm", ".json", ".svg", ".txt", ".xml", ".map",
]);
const GZIP_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const GZIP_MAX_FILE = 8 * 1024 * 1024;
const gzipCache = new Map();
let gzipCacheBytes = 0;

function clientAcceptsGzip(req) {
  return /\bgzip\b/i.test(String(req.headers["accept-encoding"] || ""));
}

async function gzipFor(abs, stat, raw) {
  const key = `${abs}|${Math.round(stat.mtimeMs)}|${stat.size}`;
  const hit = gzipCache.get(key);
  if (hit) return hit;
  const gz = await gzipAsync(raw, { level: 6 });
  if (gzipCacheBytes + gz.length > GZIP_CACHE_MAX_BYTES) {
    gzipCache.clear();
    gzipCacheBytes = 0;
  }
  gzipCache.set(key, gz);
  gzipCacheBytes += gz.length;
  return gz;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (!rel) rel = "pub/app.html";

  // 官方前端引用的是 /pub/... 这样的绝对路径，直接对到 webfiles 下
  const candidates = [
    join(paths.webfiles, rel),
    join(paths.dataDir, rel),
    safeJoin(paths.webfiles, rel),
  ];

  for (const abs of candidates) {
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      const stat = statSync(abs);
      const type = mimeOf(abs);

      // ETag（size+mtime）：Cache-Control: no-cache 只要求"每次问一遍"，
      // 但之前连校验器都没有，浏览器只能整包重下 —— 弱网下二次打开也要
      // 等十几 MB。现在命中 If-None-Match 直接回 304，一个来回完事。
      const etag = `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`;
      if (req.headers["if-none-match"] === etag) {
        res.status(304);
        res.setHeader("ETag", etag);
        res.setHeader("Cache-Control", "no-cache");
        res.end();
        return true;
      }

      const gzOk =
        clientAcceptsGzip(req) &&
        stat.size <= GZIP_MAX_FILE &&
        COMPRESSIBLE_EXT.has(extname(abs).toLowerCase());

      if (transformable(abs)) {
        const buf = await readAndRewrite(abs, stat.mtimeMs);
        if (buf) {
          res.setHeader("Content-Type", type);
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("ETag", etag);
          // 不发 X-Frame-Options：它表达不了"放行跨源祖先"，
          // 而飞牛桌面（:5666）嵌入本应用（:8163）属于跨源，发了就白屏。
          res.setHeader("Content-Security-Policy", FRAME_ANCESTORS);
          if (gzOk) {
            const gz = await gzipFor(abs, stat, buf);
            res.setHeader("Content-Encoding", "gzip");
            res.setHeader("Vary", "Accept-Encoding");
            res.setHeader("Content-Length", String(gz.length));
            res.end(gz);
          } else {
            res.setHeader("Content-Length", String(buf.length));
            res.end(buf);
          }
          return true;
        }
      }

      res.setHeader("Content-Type", type);
      res.setHeader(
        "Cache-Control",
        /\/_next\/static\/|\.(woff2?|ttf|otf|png|jpe?g|webp|svg|ico)$/i.test(abs)
          ? "public, max-age=604800"
          : "no-cache"
      );
      res.setHeader("ETag", etag);
      // 官方前端有 subApp.html / rnpage 之类的同源嵌入。
      // 同上：用 CSP frame-ancestors 而不是 X-Frame-Options。
      res.setHeader("Content-Security-Policy", FRAME_ANCESTORS);
      if (gzOk) {
        const raw = await readFile(abs);
        const gz = await gzipFor(abs, stat, raw);
        res.setHeader("Content-Encoding", "gzip");
        res.setHeader("Vary", "Accept-Encoding");
        res.setHeader("Content-Length", String(gz.length));
        res.end(gz);
      } else {
        // 大文件（音频缓存、表情包图等）照旧流式，不占内存。
        // 顺手接住读取错误：之前流中途失败会挂起连接且不留日志。
        const st = createReadStream(abs);
        st.on("error", (err) => {
          log.warn(`静态文件读取失败 ${abs}: ${err.message}`);
          if (!res.headersSent) res.status(500);
          res.destroy(err);
        });
        st.pipe(res);
      }
      return true;
    } catch {
      /* 继续试下一个候选 */
    }
  }
  return false;
}

/* ─────────────────────────── 启动自检 ─────────────────────────── */

async function doctor() {
  const missing = [];
  if (!existsSync(paths.webfiles)) missing.push("前端资源（data/webfiles）");

  /**
   * ⚠️ 这里**不要**再检查 `data/package/orpheus.ntpk`。
   *
   * 它只是 fetch-pack 阶段的**中间产物**：官方安装器解出来的前端静态文件
   * （`data/webfiles/pub/**`）才是运行期真正被读取的东西，`orpheus.ntpk`
   * 全项目只有这一处 existsSync 引用，运行时没有任何代码读它。
   *
   * 飞牛 fpk 里刻意不带这个 36MB 的原始包（只带解好的 webfiles + resource），
   * 所以继续检查它会让每次启动都误报"缺少官方包"，把真问题淹掉。
   */
  if (missing.length) {
    log.error(`缺少：${missing.join("、")}`);
    log.error("先跑一次：  npm run fetch-pack    （下载官方包并解出前端）");
    return false;
  }

  // 确认 isMainWindow 补丁在当前 pack 版本上仍然命中
  const hybrids = join(paths.webfiles, "pub", "hybrid");
  if (existsSync(hybrids)) {
    const files = (await readdir(hybrids))
      .filter((f) => f.endsWith(".js"))
      .map((f) => join(hybrids, f));
    await verifyPatch(files);
  }
  return true;
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

async function main() {
  ensureDirs();
  await loadShim();

  if (runtime.missing.length) {
    log.error(`依赖缺失：${runtime.missing.join("、")}`);
    log.error(`已挂载的模块搜索路径：${runtime.used.join(" , ") || "(无)"}`);
    log.error("包内 node_modules 与 Node.js v22 应用都没提供这些依赖，服务无法启动");
  }

  const ok = await doctor();
  if (!ok) {
    log.warn("自检未通过，服务仍会启动，但页面大概率打不开");
  }

  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", true);
  app.use(sidMiddleware);

  /* shim：必须最先可用，且带强 no-cache（改完刷新就生效） */
  app.get("/__shim.js", async (_req, res) => {
    try {
      const buf = await readFile(join(ROOT, "web", "shim.js"));
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.end(buf);
    } catch (e) {
      res.status(500).type("text/plain").end(`shim 读取失败: ${e.message}`);
    }
  });

  /* 健康检查：容器探针 / 排障用 */
  let pkgVersion = "";
  try {
    pkgVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version || "";
  } catch {
    /* ignore */
  }
  app.get("/__health", async (_req, res) => {
    res.json({
      ok: true,
      version: pkgVersion,
      port: config.port,
      pack: config.pack.version,
      data: paths.dataDir,
      webfiles: existsSync(paths.webfiles),
      sessions: sessionCount(),
      multiUser: config.multiUser,
      deviceId: config.deviceId || "(data/deviceid)",
      musicDirs: config.musicDirs,
      uptime: Math.round(process.uptime()),
    });
  });

  /* Agent API：AI 通过 skill 操控（找歌 / 下载），Bearer token 鉴权 */
  app.use("/agent", mountAgent());

  /* 反代：必须在静态之前 */
  app.use(async (req, res, next) => {
    if (req.method === "OPTIONS" && req.url.startsWith("/__p/")) {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.status(204).end();
      return;
    }
    try {
      // 封面图代理（bundle 里的 orpheus://cache/? 已被 rewrite 成 /__cache/?）
      if (await handleCache(req, res)) return;
      if (await handleProxy(req, res)) return;
    } catch (e) {
      log.error(`反代异常 ${req.url.slice(0, 120)}: ${e.message}`);
      if (!res.headersSent) res.status(502).end(e.message);
      return;
    }
    next();
  });

  /* orpheus:// 映射 —— 注意不能挂在 /orpheus 前缀上（Express 会剥掉前缀，
     而 router 自己要从 /orpheus/... 里解析出 orpheus 段） */
  app.use(async (req, res, next) => {
    if (!req.url.startsWith("/orpheus")) return next();
    try {
      await handleOrpheus(req, res);
    } catch (e) {
      log.error(`orpheus 路由异常: ${e.message}`);
      if (!res.headersSent) res.status(500).end(e.message);
    }
  });

  /* 根路径 → 官方入口（保持相对路径 ./vendor 能正确解析） */
  app.get("/", (_req, res) => {
    res.redirect(302, "/orpheus/orpheus/pub/app.html");
  });

  /* 静态前端 */
  app.use(async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    try {
      if (await serveStatic(req, res)) return;
    } catch (e) {
      log.warn(`静态服务异常 ${req.url.slice(0, 120)}: ${e.message}`);
    }
    next();
  });

  app.use((_req, res) => {
    res.status(404).type("text/plain").send("404 —— 不是 orpheus 端点，也不是前端文件");
  });

  const server = createServer(app);
  attachBridge(server);

  server.listen(config.port, config.host, () => {
    const shown = config.host === "0.0.0.0" ? "0.0.0.0" : config.host;
    log.info(`NAS-NEM 已启动  http://${shown}:${config.port}/`);
    log.info(`   数据目录  ${paths.dataDir}`);
    log.info(`   官方包    ${config.pack.version}`);
    if (runtime.used.length) log.info(`   模块路径  ${runtime.used.join(", ")}`);
    if (config.musicDirs.length) log.info(`   本地曲库  ${config.musicDirs.join(", ")}`);
  });

  const shutdown = (sig) => {
    log.info(`收到 ${sig}，正在退出…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (e) => {
    log.error(`未处理的 Promise 拒绝: ${e && e.message ? e.message : e}`);
  });
}

main().catch((e) => {
  log.error(`启动失败: ${e.stack || e.message}`);
  process.exit(1);
});
