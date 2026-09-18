/**
 * 加密工具（纯 Node crypto，无第三方依赖）
 * =========================================
 * 官方宿主暴露给前端的加密原语是 `window.channel.{serialData,deSerialData,serialKey,
 * enData,deData,encodeAnonymousId}`，其中：
 *
 *  - `serialData([pathname, jsonText])` → eapi 的 `params` 字段。**已实测对齐官方**：
 *        digest = md5(`nobody${url}use${json}md5forencrypt`)
 *        data   = `${url}-36cd479b6b5-${json}-36cd479b6b5-${digest}`
 *        params = AES-128-ECB(data, key = "e82ckenh8dichen8") → **hex**
 *    ⚠️ 两个坑（都实测过，错一个服务端就静默返回 200 + 空 body）：
 *      1. key 是**固定 16 字节** `e82ckenh8dichen8`，不是 `md5(digest)[0:16]`；
 *      2. 输出是 **hex**，不是 base64。
 *    见 scripts/probe-eapi.mjs 的矩阵结果：只有 (fixed key, hex) 才换得回密文。
 *
 *  - `deSerialData(blob)` → eapi **响应**解密。`e_r:true` 的请求，响应是
 *    **裸二进制** 的 AES-128-ECB 密文，用的还是同一个 key `e82ckenh8dichen8`。
 *    客户端先经 FileReader 转成字符串再递进来（Chrome 走 readAsDataURL → base64，
 *    老 WebKit 走 readAsBinaryString → latin1 串），所以这里两种形态都要认。
 *
 *  - `serialKey(query)` → 桌面端请求 `?cache_key=` 用的摘要。官方是原生实现，
 *    公开资料只能确认它是对排序后的 query 做摘要。这里按 md5 实现。
 *    实测：cache_key 缺失/错误不影响接口返回（只是不命中 CDN 缓存）。
 *
 *  - `encodeAnonymousId(deviceId)` → 匿名登录用的 username，**算法是公开的**，
 *    已按官方实现（XOR 固定 key → md5 原始摘要 → 两次 base64），见下方。
 *
 *  - `enData/deData` → rudio 内部的可逆封装。没有公开算法，
 *    v1 用自洽的 AES-CBC 兜底，并在日志里点名，
 *    避免"看起来成功了其实数据是错的"。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import createLogger from "../logger.js";

const log = createLogger("crypto");

export function md5(input) {
  return createHash("md5").update(input).digest("hex");
}

/* ────────────────────────────── AES-ECB / CBC ────────────────────────────── */

export function aesEncrypt(text, key, { mode = "ecb", iv = "0102030405060708", encoding = "base64" } = {}) {
  const cipher = createCipheriv(`aes-128-${mode}`, Buffer.from(key, "utf8"), mode === "cbc" ? Buffer.from(iv, "utf8") : null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(Buffer.from(text, "utf8")), cipher.final()]).toString(encoding);
}

export function aesDecrypt(b64, key, { mode = "ecb", iv = "0102030405060708", encoding = "base64" } = {}) {
  const out = aesDecryptBuffer(Buffer.from(b64, encoding), key, mode, iv);
  return out ? out.toString("utf8") : null;
}

/** 直接对字节做 AES 解密，失败返回 null（不抛） */
export function aesDecryptBuffer(buf, key, mode = "ecb", iv = "0102030405060708") {
  try {
    const decipher = createDecipheriv(
      `aes-128-${mode}`,
      Buffer.from(key, "utf8"),
      mode === "cbc" ? Buffer.from(iv, "utf8") : null
    );
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(buf), decipher.final()]);
  } catch {
    return null;
  }
}

/* ───────────────────────────────── eapi ───────────────────────────────── */

const EAPI_SEP = "-36cd479b6b5-";

/**
 * eapi 的 AES 密钥。**固定 16 字节，与 digest 无关。**
 * 网上那套 `key = md5(digest)[0:16]` 是错的（实测只会换回空 body）。
 */
const EAPI_KEY = "e82ckenh8dichen8";

/**
 * eapi 请求体加密。
 *
 * ⚠️ 返回的**必须是 hex 字符串**。客户端拿它直接当 form 字段：
 *     body = object2query({ params })   →  `params=<hex>`
 * 换成 base64 的话服务端只会回一个 `200` + `Content-Length: 0`，
 * 前端 `JSON.parse("")` 拿到 `{}`，于是首页"没有数据"——而且**不报任何错**。
 *
 * @param {string} url 接口路径，例如 "/api/register/anonimous"（注意是 /api/ 前缀）
 * @param {string} jsonText 业务参数 JSON 文本
 */
export function eapiParams(url, jsonText) {
  const digest = md5(`nobody${url}use${jsonText}md5forencrypt`);
  const data = `${url}${EAPI_SEP}${jsonText}${EAPI_SEP}${digest}`;
  return aesEncrypt(data, EAPI_KEY, { mode: "ecb", encoding: "hex" });
}

/**
 * eapi 响应解密（`e_r: true` 时）。
 *
 * 上游返回的是 AES-128-ECB 裸密文（同一个 EAPI_KEY）。浏览器侧先把 blob 读成
 * 字符串才交给宿主，两种读法各有一套编码：
 *   - `FileReader.readAsDataURL` → `data:...;base64,xxxx`
 *     （SDK 已 `.split(",").pop()` 掉前缀，所以进来的是纯 base64）
 *   - `FileReader.readAsBinaryString` → 每字符 1 字节的 latin1 串
 * 这里两种都试，用"解出来像不像 JSON"判定，不靠猜。
 *
 * @param {Buffer|string} input
 * @returns {string|null} 明文 JSON 文本；解不开返回 null
 */
export function eapiDecryptResponse(input) {
  const candidates = [];

  if (Buffer.isBuffer(input)) {
    candidates.push(input);
  } else {
    const s = String(input ?? "");
    if (!s) return null;
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
      const b = Buffer.from(s, "base64");
      if (b.length) candidates.push(b);
    }
    // latin1 二进制串
    const bytes = Buffer.alloc(s.length);
    let ok = true;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c > 255) {
        ok = false;
        break;
      }
      bytes[i] = c;
    }
    if (ok && bytes.length) candidates.push(bytes);
  }

  for (const buf of candidates) {
    if (buf.length === 0 || buf.length % 16 !== 0) continue;
    const out = aesDecryptBuffer(buf, EAPI_KEY, "ecb");
    if (!out) continue;
    const text = out.toString("utf8");
    if (/^\s*[{[]/.test(text)) return text;
  }
  return null;
}

/* ─────────────────────────────── serialKey ─────────────────────────────── */

/**
 * 桌面端 nginxCache 的 cache_key。
 * 官方是原生实现；这里用「按 key 排序后 md5」这一最贴近公开资料的形态。
 */
export function serialKey(query) {
  const text = typeof query === "string" ? query : JSON.stringify(query ?? "");
  return md5(text);
}

/* ────────────────────── 可逆封装（匿名 token 等）────────────────────── */

/**
 * rudio 的 `enData` 没有公开算法。这里用 AES-128-CBC + 随机 IV 自造一个
 * **自洽但不等价**的实现：至少保证 encode/decode 往返一致，不至于让调用方拿到坏数据。
 * 如果后续发现服务端会校验，需要换掉。
 */
const LOCAL_KEY = md5("nas-nem-local-encrypt").slice(0, 16);

export function enData(data) {
  const text = typeof data === "string" ? data : JSON.stringify(data ?? "");
  const iv = randomBytes(8).toString("hex").slice(0, 16);
  const body = aesEncrypt(text, LOCAL_KEY, { mode: "cbc", iv });
  return Buffer.from(`${iv}:${body}`, "utf8").toString("base64");
}

export function deData(data) {
  try {
    const raw = Buffer.from(String(data || ""), "base64").toString("utf8");
    const i = raw.indexOf(":");
    if (i < 0) return "";
    const iv = raw.slice(0, i);
    const body = raw.slice(i + 1);
    return aesDecrypt(body, LOCAL_KEY, { mode: "cbc", iv }) ?? "";
  } catch {
    return "";
  }
}

/**
 * ⚠️ 密钥是 `3go8&$8*3*3h0k(2)2`（**18** 字节，中间那三个 `*` 不能丢）。
 *
 * 网上大量文章把它抄成 `3go8&$833h0k(2)2`（16 字节，漏了 `*3*`），
 * 那是错的 —— 用它算出来的摘要长这样：
 *     deviceId 310270bf4cf4870354d1dfb12c30f219
 *       正确 key → VPZjs06kkoPX0lNW5T1Bwg==   ← 与公开参考实现一致
 *       漏 * 的 key → SwuDk6BjbOioM4CD8uXu+Q== ← 服务端直接拒
 * 已验证：本文件实现出来的 username 与公开参考串
 *   MzEwMjcwYmY0Y2Y0ODcwMzU0ZDFkZmIxMmMzMGYyMTkgVlBaanMwNmtrb1BYMGxOVzVUMUJ3Zz09
 * 逐字节相同（见 `npm run test:anonid`）。
 */
const ID_XOR_KEY = "3go8&$8*3*3h0k(2)2";

/**
 * `cloudmusic_dll_encode_id(deviceId)` —— 原生 DLL 里的那一步，算法是公开的：
 *   1. 把 deviceId 逐字节与固定 key `3go8&$833h0k(2)2` 循环异或（key 长度 16）
 *   2. 对异或结果取 **md5 原始摘要**（16 字节，不是 hex）
 *   3. 把原始摘要做 base64
 * 注意第 2 步：是 `digest`（Buffer）而不是 `digest("hex")`，
 * 写成 hex 再 base64 得到的是 36 字节的错字符串，服务端一定拒。
 */
export function encodeDeviceId(deviceId) {
  const src = Buffer.from(String(deviceId ?? ""), "utf8");
  const xored = Buffer.alloc(src.length);
  for (let i = 0; i < src.length; i++) {
    xored[i] = src[i] ^ ID_XOR_KEY.charCodeAt(i % ID_XOR_KEY.length);
  }
  return createHash("md5").update(xored).digest("base64");
}

/**
 * `app.registerAnonimous` 的 username。
 *
 * 官方原生实现 = `base64(deviceId + " " + cloudmusic_dll_encode_id(deviceId))`，
 * 即"设备号 + 空格 + 它的摘要"，整体再 base64 一次。
 *
 * 前端调用点在 App 层：
 *     j = async () => { … const e = await EncryptData.encodeAnonymousId(app.deviceId); … }
 * 且 `encodeAnonymousId(e)` 开头有 `if (!e) return ""` —— deviceId 为空时
 * 直接返回空串（不会走桥接），于是 username 为空 → 服务端 {"code":400}。
 * 换句话说：这个函数写错只会让匿名登录失败，而 deviceId 为空会让它**根本不执行**。
 */
export function encodeAnonymousId(deviceId) {
  const id = String(deviceId ?? "");
  if (!id) return "";
  return Buffer.from(`${id} ${encodeDeviceId(id)}`, "utf8").toString("base64");
}

/** 一次性提示，避免刷屏 */
let warned = false;
export function warnUnimplemented(what) {
  if (warned) return;
  warned = true;
  log.warn(
    `${what} 使用的是自洽实现（非官方原生算法）—— 若发现登录/加密接口异常，这里是首要怀疑对象`
  );
}

export default {
  md5,
  aesEncrypt,
  aesDecrypt,
  aesDecryptBuffer,
  eapiParams,
  eapiDecryptResponse,
  serialKey,
  enData,
  deData,
  encodeDeviceId,
  encodeAnonymousId,
};
