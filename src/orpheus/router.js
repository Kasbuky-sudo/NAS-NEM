/**
 * orpheus:// 路由层
 * ================
 * 浏览器无法注册自定义协议，所以这里把前端里 141 处 `orpheus://` 全部映射成 HTTP 路径：
 *
 *   orpheus://orpheus/<path>   →  /orpheus/orpheus/<path>   读前端包内文件 / 存储 / wasm / 皮肤
 *   orpheus://cache?<url>      →  /orpheus/cache?<url>      HTTP 缓存代理
 *   orpheus://image/?path=     →  /orpheus/image?path=      图片处理（暂直通）
 *   orpheus://localmusic/pic   →  /orpheus/localmusic/pic  本地音乐封面/歌词
 *   orpheus://file             →  /orpheus/file            本地文件
 *   orpheus://settings/... 等  →  204 空响应（桌面端导航指令，Web 端无意义）
 *
 * 两个必须注意的坑（来自 open-orpheus 的实现）：
 *  1. 查询串用 `&&` 当分隔符（不是 `&`），值里也可能含 `&`
 *  2. `orpheus://` 后面**没有双斜杠**的裸形式也存在（23 处）
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";

import config, { paths } from "../config.js";
import { safeJoin, md5, TTLCache } from "../util.js";
import createLogger from "../logger.js";
import { readAndRewrite, transformable, FRAME_ANCESTORS } from "./rewrite.js";

const log = createLogger("orpheus");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ncae": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
};

export function mimeOf(path) {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * 前端用 `&&` 当参数分隔符，不能直接用 URLSearchParams。
 * 移植自 open-orpheus `getSearchParams()`。
 */
export function getSearchParams(rawUrl) {
  const q = rawUrl.indexOf("?");
  const raw = q >= 0 ? rawUrl.slice(q + 1) : "";
  if (!raw) return new URLSearchParams();
  if (raw.includes("&&")) {
    return new URLSearchParams(
      raw
        .replace(/&&/g, "\u0000SEP\u0000")
        .replace(/&/g, "%26")
        .replace(/\u0000SEP\u0000/g, "&")
    );
  }
  return new URLSearchParams(raw);
}

/** 前端包内的候选路径：先按原样，再试 pub/ 前缀 */
const WEB_ROOT = paths.webfiles;

function resolveWebFile(rel) {
  const clean = rel.replace(/^\/+/, "").replace(/\\/g, "/");
  const candidates = [
    join(WEB_ROOT, clean),
    join(WEB_ROOT, "pub", clean),
    // 有些资源在 resource/ 里（顺带解出来的）
    safeJoin(paths.dataDir, clean),
    safeJoin(paths.dataDir, join("resource", clean)),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      /* 越界忽略 */
    }
  }
  return null;
}

/**
 * 文件响应。
 * JS / HTML 要走改写层（isMainWindow 补丁 + CSP 替换 + shim 注入），
 * 其余类型直通流式返回。
 */
async function fileResponse(path, { cacheable = true } = {}) {
  const stat = statSync(path);

  if (transformable(path)) {
    const buf = await readAndRewrite(path, stat.mtimeMs);
    if (buf) {
      return {
        status: 200,
        body: buf,
        length: buf.length,
        contentType: mimeOf(path),
        // 改写结果跟磁盘 mtime 绑定，浏览器可以放心长缓存
        cacheable,
        mtime: stat.mtime,
      };
    }
  }

  return {
    status: 200,
    body: createReadStream(path),
    length: stat.size,
    contentType: mimeOf(path),
    cacheable,
    mtime: stat.mtime,
  };
}

const textResponse = (status, text, contentType = "text/plain; charset=utf-8") => ({
  status,
  body: Buffer.from(text),
  length: Buffer.byteLength(text),
  contentType,
  cacheable: false,
});

const emptyResponse = (status = 204) => ({
  status,
  body: Buffer.alloc(0),
  length: 0,
  contentType: "text/plain",
  cacheable: false,
});

// ────────────────────────────────────────────────────────────
// HTTP 缓存代理：orpheus://cache?<url>
// 前端把图片/资源请求丢给宿主去代理（顺带绕过 CORS）
// ────────────────────────────────────────────────────────────
const memCache = new TTLCache(10 * 60_000, 300);

async function handleCache(rawUrl) {
  const params = getSearchParams(rawUrl);
  // 形态 A: orpheus://cache?<url>
  let target = [...params.keys()].find((k) => /^https?:/i.test(k));
  // 形态 B: orpheus://cache/?url=<url>
  if (!target) target = params.get("url");

  if (!target) {
    // 可能是 orpheus://cache/<path> 形式，转交前端包
    const pathPart = rawUrl.replace(/^orpheus:\/\/cache\/?/, "").split("?")[0];
    if (pathPart) {
      const p = resolveWebFile(pathPart);
      if (p) return fileResponse(p);
    }
    return textResponse(400, "cache: 缺少 url 参数");
  }
  return proxyFetch(target);
}

/** 统一的宿主级代理请求（带 UA，绕过 CORS） */
export async function proxyFetch(target) {
  const cached = memCache.get(target);
  if (cached) return cached;

  const res = await fetch(target, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Referer: "https://music.163.com/",
    },
    redirect: "follow",
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const out = {
    status: res.status,
    body: buf,
    length: buf.length,
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
    cacheable: true,
  };
  if (res.ok) memCache.set(target, out, 10 * 60_000);
  return out;
}

// ────────────────────────────────────────────────────────────
// 图片处理：orpheus://image/?path=<本地路径>
// 完整实现需要缩放/裁剪，这里先直通本地文件
// ────────────────────────────────────────────────────────────
async function handleImage(rawUrl) {
  const params = getSearchParams(rawUrl);
  const p = params.get("path");
  if (!p) return emptyResponse(404);
  try {
    const abs = safeJoin(paths.storage, p);
    if (!existsSync(abs)) return emptyResponse(404);
    return fileResponse(abs);
  } catch {
    return emptyResponse(403);
  }
}

// ────────────────────────────────────────────────────────────
// wasm 资源：orpheus://orpheus/wasm/<type>?url=&MD5=&name=&fetchFromServer=
// 前端的 lyrics-effect / SDK 等 WASM 从这里取
// ────────────────────────────────────────────────────────────
async function handleWasm(pathname, rawUrl) {
  const params = getSearchParams(rawUrl);
  const type = pathname.slice("/orpheus/orpheus/wasm/".length) || "unknown";
  const url = params.get("url");
  const expected = params.get("MD5");
  const fromServer = params.get("fetchFromServer") === "true";

  if (url && expected) {
    const ext = extname(new URL(url, "https://x/").pathname);
    const cachedPath = join(paths.wasm, expected + ext);
    if (existsSync(cachedPath)) return fileResponse(cachedPath);

    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return textResponse(res.status, `wasm 下载失败: ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = md5(buf);
    if (got !== expected) {
      log.warn(`wasm MD5 不符 type=${type} 期望=${expected} 实得=${got}`);
    }
    await mkdir(paths.wasm, { recursive: true });
    await writeFile(cachedPath, buf);
    log.info(`wasm 已缓存 ${type} → ${cachedPath}`);
    return {
      status: 200,
      body: buf,
      length: buf.length,
      contentType: "application/wasm",
      cacheable: true,
    };
  }
  if (fromServer) return emptyResponse(204);

  // 没有 url 参数：可能请求的是包内自带 wasm
  const inPack = resolveWebFile(pathname.replace("/orpheus/orpheus/", ""));
  if (inPack) return fileResponse(inPack);
  return textResponse(400, `wasm: 不支持的请求 type=${type}`);
}

// ────────────────────────────────────────────────────────────
// 本地音乐：orpheus://localmusic/pic|lyric
// ────────────────────────────────────────────────────────────
async function handleLocalMusic(rest, rawUrl) {
  const params = getSearchParams(rawUrl);
  const id = params.get("id") ?? params.get("tid") ?? "";
  if (!id) return emptyResponse(404);

  if (rest.startsWith("pic")) {
    // 本地音乐封面：在 NAS 音乐目录里找同名图片
    for (const dir of config.musicDirs) {
      try {
        const abs = safeJoin(dir, id);
        if (existsSync(abs)) return fileResponse(abs);
      } catch {
        /* noop */
      }
    }
    return emptyResponse(404);
  }
  if (rest.startsWith("lyric")) {
    // 本地歌词文件
    for (const dir of config.musicDirs) {
      for (const ext of [".lrc", ".LRC", ".txt"]) {
        try {
          const abs = safeJoin(dir, id.replace(/\.[^.]+$/, "") + ext);
          if (existsSync(abs)) {
            const t = await readFile(abs, "utf8");
            return textResponse(200, t);
          }
        } catch {
          /* noop */
        }
      }
    }
    return emptyResponse(404);
  }
  return emptyResponse(404);
}

// ────────────────────────────────────────────────────────────
// 主入口
// ────────────────────────────────────────────────────────────
export async function handleOrpheus(req, res) {
  // req.url 形态： /orpheus/orpheus/pub/app.html?x=1
  const raw = req.url.replace(/^\/orpheus\/?/, "");
  const pathOnly = raw.split("?")[0];
  const firstSeg = pathOnly.split("/")[0];

  let out;
  try {
    switch (firstSeg) {
      case "orpheus": {
        const inner = pathOnly.slice("orpheus".length).replace(/^\/+/, "");
        if (inner.startsWith("wasm/")) {
          out = await handleWasm("/orpheus/orpheus/" + inner, raw);
          break;
        }
        if (inner === "storage/local") {
          const p = getSearchParams(raw).get("file");
          if (!p) { out = emptyResponse(400); break; }
          const abs = safeJoin(paths.storage, p);
          out = existsSync(abs)
            ? await fileResponse(abs, { cacheable: false })
            : emptyResponse(404);
          break;
        }
        if (inner === "storage/customrequest") {
          out = await handleCustomRequest(req, raw);
          break;
        }
        if (inner.startsWith("customskin")) {
          out = await handleCustomSkin(raw);
          break;
        }
        if (inner === "aioresource" || inner === "cacheresource") {
          const url = getSearchParams(raw).get("url") || getSearchParams(raw).get("id");
          out = url && /^https?:/i.test(url) ? await proxyFetch(url) : emptyResponse(404);
          break;
        }
        if (inner === "" || inner === "app.html") {
          out = await serveEntry();
          break;
        }
        out = await handlePackFile(inner);
        break;
      }
      case "cache":
        out = await handleCache(raw);
        break;
      case "image":
        out = await handleImage(raw);
        break;
      case "localmusic":
        out = await handleLocalMusic(pathOnly.slice("localmusic".length).replace(/^\/+/, ""), raw);
        break;
      case "file":
        out = await handleLocalFile(raw);
        break;
      // 桌面端导航/动作指令：Web 端无意义，静默吞掉
      case "settings":
      case "route":
      case "rnpage":
      case "openurl":
      case "appModal":
      case "desktop":
      case "openVipCashier":
      case "openSvipCashier":
      case "openDevicesManage":
        log.debug(`忽略桌面导航指令: ${raw.slice(0, 90)}`);
        out = emptyResponse(204);
        break;
      case "":
        out = await serveEntry();
        break;
      default:
        out = textResponse(404, `未知 orpheus 端点: ${firstSeg}`);
    }
  } catch (e) {
    log.error(`处理失败 ${raw.slice(0, 120)} → ${e.message}`);
    out = textResponse(500, e.message);
  }

  sendResponse(res, out, req);
}

/** 读前端包内文件 */
async function handlePackFile(rel) {
  const p = resolveWebFile(rel);
  if (!p) {
    log.debug(`包内未找到: ${rel}`);
    return emptyResponse(404);
  }
  return fileResponse(p);
}

/** 入口页：pub/app.html，注入 shim + 换 CSP 后返回 */
let entryPath = undefined;
async function serveEntry() {
  if (entryPath === undefined) {
    entryPath = null;
    for (const c of ["pub/app.html", "app.html", "pub/index.html", "index.html"]) {
      const p = resolveWebFile(c);
      if (p) {
        entryPath = p;
        log.info(`入口页: ${p}`);
        break;
      }
    }
  }
  if (!entryPath) return textResponse(404, "前端入口未找到（pub/app.html）");

  const stat = statSync(entryPath);
  const rewritten = await readAndRewrite(entryPath, stat.mtimeMs);
  const buf = rewritten ?? (await readFile(entryPath));
  return {
    status: 200,
    body: buf,
    length: buf.length,
    contentType: "text/html; charset=utf-8",
    cacheable: false,
  };
}

/** 自定义请求：前端把需要签名/带 cookie 的请求交给宿主 */
async function handleCustomRequest(req, raw) {
  const params = getSearchParams(raw);
  const url = params.get("url");
  if (!url || !/^https?:/i.test(url)) return emptyResponse(400);
  const host = new URL(url).hostname;
  if (!config.allowedApiHosts.some((h) => host === h || host.endsWith("." + h))) {
    log.warn(`customrequest 域名不在白名单: ${host}`);
    return emptyResponse(403);
  }
  return proxyFetch(url);
}

/** 自定义皮肤：orpheus://orpheus/customskin?id=&name=&url= */
async function handleCustomSkin(raw) {
  const params = getSearchParams(raw);
  const url = params.get("url");
  const name = params.get("name");
  if (url) {
    const r = await proxyFetch(url);
    if (name) {
      try {
        await mkdir(join(paths.wasm, "skin"), { recursive: true });
        await writeFile(join(paths.wasm, "skin", name), r.body);
      } catch (e) {
        log.warn(`保存皮肤失败: ${e.message}`);
      }
    }
    return r;
  }
  if (name) {
    const p = join(paths.wasm, "skin", name);
    if (existsSync(p)) return fileResponse(p);
  }
  return emptyResponse(404);
}

/** 本地文件：orpheus://file?path= */
async function handleLocalFile(raw) {
  const params = getSearchParams(raw);
  const p = params.get("path") ?? params.get("file");
  if (!p) return emptyResponse(400);
  // 只允许访问配置的音乐目录
  for (const dir of config.musicDirs) {
    try {
      const abs = safeJoin(dir, p);
      if (existsSync(abs)) return fileResponse(abs);
    } catch {
      /* noop */
    }
  }
  return emptyResponse(404);
}

function sendResponse(res, out, req) {
  if (!out) {
    res.status(500).end("empty response");
    return;
  }
  res.status(out.status ?? 200);
  if (out.contentType) res.setHeader("Content-Type", out.contentType);
  if (out.length !== undefined) res.setHeader("Content-Length", String(out.length));
  if (out.cacheable) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.setHeader("Cache-Control", "no-store");
  }
  // 允许被跨源嵌入（飞牛桌面 :5666 用 iframe 打开本应用 :8163）。
  // 不能用 X-Frame-Options: SAMEORIGIN —— 它表达不了"放行某个跨源祖先"，
  // 一发就白屏；白名单只能交给 CSP 的 frame-ancestors。
  res.setHeader("Content-Security-Policy", FRAME_ANCESTORS);

  if (out.body && typeof out.body.pipe === "function") {
    out.body.pipe(res);
  } else {
    res.end(out.body);
  }
}

export default handleOrpheus;
