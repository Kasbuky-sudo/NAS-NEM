/**
 * 同源反向代理
 * ==============
 * 官方前端的请求全部打向 `https://music.163.com` / `https://interface.music.163.com`
 * （以及一堆 CDN）。浏览器里这些跨源请求会被 CORS 挡死 —— 桌面端之所以能跑，
 * 是因为 CEF 不执行同源策略。
 *
 * 这里走"同源反代"路线：shim 把网易域名的绝对 URL 改写成
 *     /__p/<host>/<path>?<query>
 * 由本模块转发。好处：
 *   - 彻底没有 CORS 问题；
 *   - cookie 天然同源 —— 我们把上游的 Set-Cookie 去掉 Domain/Secure/HttpOnly
 *     落到本机域名上，浏览器就会自动带上，官方前端读 document.cookie 也读得到；
 *   - 顺便统一 UA / Referer，并集中处理压缩、跳转、Range。
 */
import { Readable } from "node:stream";
import { appendFileSync } from "node:fs";

import config from "../config.js";
import createLogger from "../logger.js";
import { eapiDecryptResponse } from "../crypto/eapi.js";
import { ensureSession } from "../bridge/server.js";

const log = createLogger("proxy");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** 这些请求头由 Node/undici 自己管，不能透传 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "accept-encoding", // 交给 undici 协商，否则拿到压缩流解不开
  "origin", // 上游按 Origin 做校验时容易翻车，用 Referer 表达身份
  "referer",
]);

const PREFIX = "/__p/";

/**
 * 取本机会话 id。
 * `index.js` 的 `sidMiddleware` 保证每个请求都带 `nas_sid`（没有就现发一个
 * 并写回 `req.headers.cookie`），WS 桥接用的是同一个值，所以反代这边能
 * 精确定位到"这个浏览器"的 cookie 罐。
 */
function sidOf(req) {
  const m = /(?:^|;\s*)nas_sid=([^;]+)/.exec(req.headers.cookie || "");
  if (!m) return "";
  const v = decodeURIComponent(m[1]);
  return /^[A-Za-z0-9_-]{4,64}$/.test(v) ? v : "";
}

/**
 * 响应侧同样要剥掉逐跳头。
 * `transfer-encoding` 尤其不能透传：上游回 chunked，我们又要 `Readable.pipe`
 * 自己再分一次帧，两层 framing 叠在一起，客户端很容易读出"status 200 但 body 空"。
 * 之前只跳过了 content-length / content-encoding，漏了这几个。
 */
const HOP_BY_HOP_RESP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
]);

export function isProxyPath(url) {
  return url.startsWith(PREFIX);
}

function hostAllowed(host) {
  const h = host.toLowerCase();
  return config.allowedApiHosts.some((s) => h === s || h.endsWith("." + s));
}

/** 上游 Set-Cookie → 本机 cookie（去掉 Domain/Secure/HttpOnly，保留 Path/Max-Age） */
function downgradeCookie(raw) {
  const parts = raw.split(";").map((s) => s.trim());
  const kept = [];
  for (const p of parts) {
    const k = p.split("=")[0].trim().toLowerCase();
    if (k === "domain" || k === "secure" || k === "httponly" || k === "samesite") continue;
    if (k === "path") {
      kept.push("Path=/");
      continue;
    }
    kept.push(p);
  }
  if (!kept.some((p) => /^path=/i.test(p))) kept.push("Path=/");
  return kept.join("; ");
}

/**
 * 处理 `/__cache/?<图片真实 URL>`。
 *
 * 官方前端的封面图长这样：
 *     orpheus://cache/?https://p1.music.126.net/xxx.jpg?imageView&thumbnail=560y208
 * 前缀 `orpheus://cache/?` 是 CEF 注册的自定义协议（顺便做本地图片缓存）。
 * 浏览器根本不认 `orpheus:` 这个 scheme —— 就算把它写进 CSP 的 `img-src`，
 * 也只会得到 `ERR_UNKNOWN_URL_SCHEME`，封面一张都出不来。
 *
 * 所以 rewrite.js 把 bundle 里的那个前缀常量换成了同 origin 的 `/__cache/?`，
 * 由这里把后面的真实 URL 取出来代理过去。走同源而不是直接跳 CDN，是为了让
 * 取主题色那段 `drawImage` + `getImageData` 不会因为跨域拿不到 CORS 头而炸。
 */
const CACHE_PREFIX = "/__cache/?";

export function isCachePath(url) {
  return typeof url === "string" && url.includes(CACHE_PREFIX);
}

export async function handleCache(req, res) {
  if (!isCachePath(req.url)) return false;

  const i = req.url.indexOf(CACHE_PREFIX);
  let target = req.url.slice(i + CACHE_PREFIX.length);
  const hash = target.indexOf("#");
  if (hash >= 0) target = target.slice(0, hash);

  let u;
  try {
    u = new URL(target);
  } catch {
    res.status(400).end("bad cache target");
    return true;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    res.status(400).end("bad cache scheme");
    return true;
  }
  if (!hostAllowed(u.host)) {
    log.warn(`拒绝代理非白名单图片域名: ${u.host}`);
    res.status(403).end("host not allowed");
    return true;
  }

  let upstream;
  try {
    upstream = await fetch(u.href, {
      headers: { "user-agent": UA, referer: "https://music.163.com/", accept: "image/avif,image/webp,image/*,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(config.requestTimeout),
    });
  } catch (e) {
    log.warn(`图片代理失败 ${u.href.slice(0, 110)} → ${e.message}`);
    res.status(502).end("image upstream failed");
    return true;
  }

  res.status(upstream.status);
  const ct = upstream.headers.get("content-type");
  if (ct) res.setHeader("content-type", ct);
  const cc = upstream.headers.get("cache-control");
  res.setHeader("cache-control", cc || "public, max-age=86400");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("timing-allow-origin", "*");

  if (!upstream.body || req.method === "HEAD") {
    res.end();
    return true;
  }
  try {
    Readable.fromWeb(upstream.body).pipe(res);
  } catch {
    res.end();
  }
  return true;
}

/**
 * 处理 `/__p/<host>/<rest>` 请求。
 * @returns {Promise<boolean>} 是否已接管（false 表示不是代理路径）
 */
export async function handleProxy(req, res) {
  if (!isProxyPath(req.url)) return false;

  const rest = req.url.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  const host = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
  const tail = slash < 0 ? "/" : rest.slice(slash);

  if (!host || !/^[a-z0-9.\-:]+$/i.test(host)) {
    res.status(400).end("bad proxy host");
    return true;
  }
  if (!hostAllowed(host)) {
    log.warn(`拒绝代理非白名单域名: ${host}`);
    res.status(403).end(`host not allowed: ${host}`);
    return true;
  }

  const scheme = host === "musicupload.netease.com" ? "http" : "https";
  const target = `${scheme}://${host}${tail}`;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  headers["user-agent"] = UA;
  headers["referer"] = "https://music.163.com/";
  /**
   * ⚠️ `X-os: pc` —— **一个请求头决定了半个首页能不能加载**。
   *
   * 上游每个响应都会带 `MConfig-Info`（配置中心指针）和 `MConfig-Bucket`，
   * 客户端用它们更新 configCenter；但更新入口有一道硬门槛：
   *
   *     async resolveFromRequest(e) {
   *       const n = e.confInfo || {};
   *       if (!n.version || "pc" !== n.os) return;   // ← 不是 pc 就整段放弃
   *       …  n.fullUrl 拉配置 JSON  →  configFromRequest$.next(...)
   *     }
   *
   * 而 `n.os` 由**上游按客户端类型**决定：不带这个头时实测恒为 `"web"`，
   * 于是配置中心永远是空对象，所有 `preload#xxx` 开关都走默认值，
   * 首页推荐区块（fetchBlocksData）第一步 `if (!enableRecommend) return`
   * 直接静默退出 —— 表现为"页面主体空白、控制台一个错都没有"。
   *
   * 实测（scripts/probe-mconfig*.mjs 矩阵）：能把它掰成 `pc` 的只有两招，
   * `X-os: pc` 或 `Cookie: os=pc`；改 UA / 换 host / X-Client-Os 都没用。
   * 这里选请求头，避免往浏览器 cookie 里塞无关字段。
   */
  headers["x-os"] = "pc";
  // MUSIC_U 等 cookie 由浏览器以本机域名携带，直接透传
  if (req.headers.cookie) headers["cookie"] = req.headers.cookie;

  const method = req.method || "GET";
  const init = {
    method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(config.requestTimeout),
  };

  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    log.warn(`上游请求失败 ${target} → ${e.message}`);
    res.status(502).json({ code: 502, msg: `upstream failed: ${e.message}` });
    return true;
  }

  log.debug(`${method} ${host}${tail.slice(0, 90)} → ${upstream.status}`);

  /* ─────────────── 把上游 Set-Cookie 搬进桥接 cookie 罐 ───────────────
   *
   * 桌面端里 CEF 的网络层和 SDK 的 `Cookie.getAll` **共用同一个罐子**，
   * 响应里的 Set-Cookie 天然对前端可见，所以 `createAnonimous` 能拿到
   * `MUSIC_A` / `MUSIC_U`，`getHostForLogin` 也就走得到"切换到自动登录用户"分支。
   *
   * 网页版是**两套罐子**：浏览器自己的（由本文件末尾的 Set-Cookie 落地）+ 桥接
   * 罐子（SDK 的 `browser.setCookie` / `browser.getFullCookies` 读写）。
   * `register/anonimous` 的 Set-Cookie 只落进前者，桥接罐子里永远只有
   * os/deviceId/osver/appver/clientSign/channel 这六条客户端自写的，
   * 于是：
   *     getHostForLogin: 两个分支都要求 MUSIC_A → 全落空
   *     → return {}            （还会顺手 v.delete() / h.delete()）
   *     → host.uid 恒空
   *     → `page:essential/fetchBlocksData` 首行 `if (!v.uid && !) return`
   *       静默返回 → 首页/精选所有区块空白，控制台零报错。
   *
   * 所以这里必须做一次"跨罐搬运"。只对 163 系域名搬，免得 CDN 的垃圾
   * cookie 把罐子撑爆。
   */
  const upSetCookies = upstream.headers.getSetCookie?.() ?? [];
  if (upSetCookies.length && /163\.com$|126\.net$/.test(host)) {
    const sid = sidOf(req);
    if (sid) {
      try {
        const ctx = await ensureSession(sid);
        let ok = 0;
        for (const line of upSetCookies) if (ctx.cookies().set(target, line)) ok++;
        if (ok) {
          ctx.saveCookies?.();
          log.info(`[cookie] ${host} → 桥接罐写入 ${ok}/${upSetCookies.length} 条（罐内共 ${ctx.cookies().size()}）`);
        }
      } catch (e) {
        log.warn(`写入桥接 cookie 罐失败: ${e.message}`);
      }
    }
  }

  // 跳转：把 Location 折回本机代理路径，免得浏览器直接跳去网易（然后又撞 CORS）
  const loc = upstream.headers.get("location");
  const out = new Headers();
  for (const [k, v] of upstream.headers) {
    const lk = k.toLowerCase();
    if (lk === "set-cookie") continue;
    if (lk === "content-encoding" || lk === "content-length") continue;
    if (HOP_BY_HOP_RESP.has(lk)) continue;
    if (lk === "location") continue;
    if (lk === "content-security-policy" || lk === "x-frame-options") continue;
    out.set(k, v);
  }
  if (loc) {
    try {
      const abs = new URL(loc, target);
      out.set("location", isProxyable(loc) ? PREFIX + abs.host + abs.pathname + abs.search : loc);
    } catch {
      out.set("location", loc);
    }
  }
  out.set("access-control-allow-origin", "*");

  res.status(upstream.status);
  for (const [k, v] of out) res.setHeader(k, v);
  // cookie：去掉 Domain/Secure/HttpOnly，落到本机域名上，浏览器才会自动携带
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  if (cookies.length) res.setHeader("set-cookie", cookies.map(downgradeCookie));

  if (config.debugProxy) {
    let written = 0;
    const _write = res.write.bind(res);
    const _end = res.end.bind(res);
    res.write = (c, ...r) => {
      if (c) written += Buffer.byteLength(c);
      return _write(c, ...r);
    };
    res.end = (c, ...r) => {
      if (c) written += Buffer.byteLength(c);
      return _end(c, ...r);
    };
    log.info(
      `[proxy] → ${method} ${host}${tail.slice(0, 80)} ` +
        `reqCL=${req.headers["content-length"] || "-"} reqCT=${(req.headers["content-type"] || "-").slice(0, 40)} ` +
        `reqCookieLen=${(req.headers.cookie || "").length} ` +
        `| 上游 status=${upstream.status} upCL=${upstream.headers.get("content-length") || "-"} ` +
        `upEnc=${upstream.headers.get("content-encoding") || "-"} upTE=${upstream.headers.get("transfer-encoding") || "-"}`
    );
    res.on("finish", () => {
      log.info(`[proxy] ← ${method} ${tail.slice(0, 80)} 写给客户端=${written}B`);
    });
    res.on("close", () => {
      if (!res.writableFinished) log.warn(`[proxy] ✖ ${method} ${tail.slice(0, 80)} 客户端提前断开（已写 ${written}B）`);
    });
  }

  if (method === "HEAD" || !upstream.body) {
    res.end();
    return true;
  }

  /**
   * 调试：把 eapi 响应**解密后**落盘。
   * NASNEM_DUMP_API=<文件> 时开启。
   *
   * 为什么放在代理层而不是桥接层：只有这里同时知道 URL 和原始字节。
   * 桥接层的 `deSerialData` 拿到的是「浏览器转成字符串之后」的密文，
   * 既没有 URL 也没法保证顺序（异步会交错，配对经常错位）。
   * 前端那一堆"页面空着但一个错都不报"的毛病，十有八九是某个接口返回了
   * 意外的结构 —— 没有这份明文就只能靠猜。
   */
  /**
   * ⚠️ 血的教训：dump 必须**完全旁路**，绝不能碰给客户端的那条 body。
   *
   * 上一版是 `const buf = await upstream.arrayBuffer(); ...; res.end(buf);`——
   * 看着没问题，实测是灾难：凡是命中 dump 的 URL（也就是所有 eapi POST），
   * 浏览器收到的 body 恒为 **0 字节**（status 还是 200，所以前端一个错都不报，
   * 首页区块就只能永远空着）。而没命中 dump 的请求（图片、config 数据）全都正常。
   * 同一时刻 Node 端 fetch 打同一个 URL 却拿得到 4199 字节 —— 说明上游和
   * 代理的产出都没问题，问题就在这条"我顺手把 body 转给了客户端"的路径上。
   *
   * 正确做法：`clone()` 一份专门给 dump，原 body 原封不动走下面的 pipe。
   * dump 失败只写日志，绝不影响转发。
   */
  if (config.dumpApi && /\/(eapi|weapi|neapi|api)\//.test(tail)) {
    const forDump = upstream.clone();
    forDump
      .arrayBuffer()
      .then((raw) => {
        const buf = Buffer.from(raw);
        const plain = eapiDecryptResponse(buf) ?? (buf.length ? `<未加密/解密失败 ${buf.length}B>` : "<空响应体>");
        appendFileSync(
          config.dumpApi,
          JSON.stringify({
            t: Date.now(),
            method,
            url: `${scheme}://${host}${tail}`,
            status: upstream.status,
            bytes: buf.length,
            // 配置中心指针也一并记下来：os 不是 pc 的话 configCenter 会是空的，
            // 而"configCenter 空"会让一堆功能静默降级，且**不产生任何错误**。
            bucket: upstream.headers.get("mconfig-bucket") || null,
            mconfig: (() => {
              const rawHdr = upstream.headers.get("mconfig-info");
              if (!rawHdr) return null;
              try {
                return JSON.parse(rawHdr).IuRPVVmc3WWul9fT || rawHdr.slice(0, 200);
              } catch {
                return rawHdr.slice(0, 200);
              }
            })(),
            body: plain.length > 20000 ? plain.slice(0, 20000) + `…(+${plain.length - 20000})` : plain,
          }) + "\n"
        );
      })
      .catch((e) => log.warn(`API dump 失败（不影响转发）: ${e.message}`));
  }

  Readable.fromWeb(upstream.body).pipe(res);
  return true;
}

function isProxyable(u) {
  try {
    return hostAllowed(new URL(u).host);
  } catch {
    return false;
  }
}

/** OPTIONS 预检（虽然同源了基本用不上，留着兼容自定义前端） */
export function handlePreflight(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.status(204).end();
}

export default handleProxy;
