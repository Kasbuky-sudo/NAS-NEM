/**
 * 会话级 cookie 罐
 * =================
 * 两条路都要用：
 *   - `/__p/` 同源反代：浏览器自己带 cookie，但响应里的 Set-Cookie 我们改写过，
 *     服务端再存一份，方便 `browser.getCookies` / `network.fetch` 这两条"走桥"的路径复用。
 *   - `network.fetch`：没有浏览器参与，只能从罐里取。
 *
 * 落盘到 `data/users/<id>/cookies.json`，重启不丢登录态。
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CookieJar } from "tough-cookie";

import createLogger from "../logger.js";

const log = createLogger("cookies");

/**
 * 把 tough-cookie 的过期时间（Date / Infinity / 毫秒数）折成**秒级 unix 时间戳**。
 *
 * ⚠️ 为什么非得是数字：官方前端里挑 cookie 的函数长这样
 *
 *     d = e => { … t = e.Expires || ""
 *                t = parseInt(t, 10)          // ← 只认数字前缀
 *                t < 174e10 && (t *= 1e3)
 *                return Number(new Date) > t }
 *     f = (name, list) => list.filter(e => !d(e)).find(e => e.name === name)
 *
 * 我们以前直接把 `c.expires`（tough-cookie 给的是 **Date**）塞进 `Expires`，
 * 经 JSON 变成 `"2027-09-18T02:25:51.000Z"`，`parseInt` 只吃出 **`2027`**（年份！），
 * ×1000 后是 1970 年 → 判定"已过期" → **所有服务端下发的 cookie 全被 filter 扔掉**。
 * 而客户端自己写的那几条 `Expires` 是 `Infinity`，`parseInt` 得 `NaN`，
 * `NaN` 参与比较恒为 false，反倒"永不过期"活了下来 ——
 * 表现就是罐子里有 MUSIC_A，但"找 MUSIC_A"永远找不到，
 * `getHostForLogin` 两条分支一起落空 → `return {}` → host.uid 恒空 → 首页空白。
 *
 * 会话 cookie（没有过期时间）返回 null：官方那套逻辑下 `Expires` 为空等价于
 * "不过期"，正是我们要的语义。
 */
function toEpochSeconds(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? Math.floor(v.getTime() / 1000) : null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null; // Infinity / NaN / 非法字符串
  // tough-cookie 用毫秒epoch；万一上游给的是秒（10 位）也别再除一刀
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

export class SessionCookies {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, "cookies.json");
    this.jar = new CookieJar();
    this.dirty = false;
    this.#load();
  }

  #load() {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, "utf8"));
        this.jar = CookieJar.fromJSON(raw);
      }
    } catch (e) {
      log.warn(`读取 cookie 罐失败: ${e.message}`);
    }
  }

  /** 拿某个 URL 的 Cookie 头 */
  getHeader(url) {
    try {
      const c = this.jar.getCookieStringSync(url);
      return c || "";
    } catch {
      return "";
    }
  }

  /**
   * 写入一条 Set-Cookie 原文。
   *
   * ⚠️ 这里**故意不用** `ignoreError: true`。
   * 之前为了"别打断启动"而静默吞错，结果 setCookie 全链路 no-op 也一声不吭，
   * 排查花了几小时（详见 calls/browser.js 顶部的血案记录）。
   * tough-cookie 的报错（非法域、过期时间格式错、公共后缀拒绝）都是**真信息**，
   * 宁可吵一点也要打出来。
   */
  set(url, setCookieLine) {
    try {
      this.jar.setCookieSync(setCookieLine, url);
      this.dirty = true;
      return true;
    } catch (e) {
      log.warn(`写入 cookie 失败: ${e.message} —— 原文 ${setCookieLine.slice(0, 100)} (url=${url})`);
      return false;
    }
  }

  /** 列出某个 URL 可见的 cookie */
  list(url) {
    try {
      return this.jar.getCookiesSync(url).map((c) => ({
        Name: c.key,
        Value: c.value,
        Domain: c.domain,
        Path: c.path,
        Expires: toEpochSeconds(c.expires),
        HasExpires: toEpochSeconds(c.expires) !== null,
        HttpOnly: c.httpOnly,
        Secure: c.secure,
      }));
    } catch {
      return [];
    }
  }

  /** 罐内 cookie 总数（跨全部域）—— 排查"写了读不回来"时最有用的一眼 */
  size() {
    try {
      return this.jar.serializeSync().cookies.length;
    } catch {
      return -1;
    }
  }

  /**
   * 删除某条 cookie。
   *
   * ⚠️ 别用 `jar.removeCookieSync(url, name)` —— tough-cookie 的签名是
   *    `removeCookie(cookieOrString, currentUrl)`，把 url 当 cookie、name 当 url，
   *    结果是**静默失败**（我们外面还 catch 了，连日志都没有）。
   * 这里改成"找到同域同路径的那条，再写一条过期时间在 1970 的覆盖它"，语义明确且必然生效。
   */
  remove(url, name) {
    try {
      const target = this.jar.getCookiesSync(url).filter((c) => c.key === name);
      for (const c of target) {
        this.jar.setCookieSync(
          `${c.key}=; Domain=${c.domain}; Path=${c.path}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
          url,
          { ignoreError: true }
        );
      }
      if (target.length) this.dirty = true;
      else log.debug(`删除 cookie ${name}@${url} —— 罐里没有这条`);
    } catch (e) {
      log.debug(`删除 cookie 失败: ${e.message}`);
    }
  }

  clear() {
    this.jar = new CookieJar();
    this.dirty = true;
  }

  async save() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await writeFile(this.file, JSON.stringify(this.jar.toJSON()), "utf8");
    } catch (e) {
      log.warn(`保存 cookie 罐失败: ${e.message}`);
    }
  }
}

export default SessionCookies;
