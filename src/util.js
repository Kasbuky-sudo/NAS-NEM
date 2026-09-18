/**
 * 通用工具。
 */
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 把用户可控的相对路径安全地拼到一个根目录下，挡住路径穿越。
 * 返回绝对路径；若越界则抛错。
 */
export function safeJoin(root, relative) {
  const cleaned = decodeURIComponent(String(relative ?? ""))
    .replace(/^[/\\]+/, "")
    .replace(/\\/g, "/");
  const target = resolve(root, normalize(cleaned));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new Error(`路径越界: ${relative}`);
  }
  return target;
}

/**
 * 把"官方客户端口径"的路径折算进会话沙箱。
 * ------------------------------------------------
 * 官方前端满嘴都是 Windows / macOS 的绝对路径，例如
 *   C:\Users\x\AppData\Local\Netease\CloudMusic\webdata\file\history
 *   /Users/x/Documents/storage/file_storage/webdata/file/history
 * 甚至还有拿不到 cacheDir 时拼出来的畸形路径
 *   undefined\..\webdata\file\history
 * Web 版统一折算成会话目录下的相对位置：
 *   1. 路径里出现 `webdata` → 从它开始截断（这一条覆盖上面三种花样）
 *   2. 否则若是绝对路径 → 只保留末尾两段，避免照搬别人的目录结构
 *   3. 其余当相对路径
 * 结果一律走 safeJoin，越界直接抛错。
 */
export function clientPath(root, p, mode) {
  let s = String(p ?? "").trim().replace(/\\/g, "/");
  if (s.startsWith("file://")) {
    try {
      s = fileURLToPath(s);
    } catch {
      /* ignore */
    }
  }
  const wd = s.indexOf("webdata");
  if (wd >= 0) {
    s = s.slice(wd);
  } else if (mode === "abs" || /^[a-zA-Z]:\//.test(s) || s.startsWith("/")) {
    s = s
      .split("/")
      .filter(Boolean)
      .slice(-2)
      .join("/");
  }
  return safeJoin(root, s);
}

export function md5(input) {
  return createHash("md5").update(input).digest("hex");
}

export function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function randomId(bytes = 8) {
  return randomBytes(bytes).toString("hex");
}

/** 简单的 TTL 内存缓存 */
export class TTLCache {
  constructor(ttlMs = 60_000, max = 500) {
    this.ttl = ttlMs;
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expire) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key, value, ttl = this.ttl) {
    if (this.map.size >= this.max) {
      this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, { value, expire: Date.now() + ttl });
    return value;
  }
  /** 取或算 */
  async wrap(key, factory) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await factory();
    return this.set(key, value);
  }
}

/** 把 ReadableStream 收到 Buffer */
export async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function isInside(parent, child) {
  const p = isAbsolute(parent) ? parent : resolve(parent);
  const c = isAbsolute(child) ? child : resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}
