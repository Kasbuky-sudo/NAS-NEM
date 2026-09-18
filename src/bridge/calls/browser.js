/**
 * browser.* —— cookie 读写
 * ===========================
 * 官方 SDK 的 Cookie 类走这里：
 *     Cookie.set({url,name,value,…}) → At.call("browser.setCookie",  CEF对象)
 *     Cookie.getAll({url})           → At.call("browser.getFullCookies", url串)
 *     Cookie.get(url)                → At.call("browser.getCookies", url串)
 *     Cookie.delete({url,name})      → At.call("browser.removeCookie", url串, name串)
 *
 * 桌面端操作的是 CEF 的 cookie store，Web 版操作的是**我们自己的罐**。
 *
 * ⚠️⚠️ 字段大小写是这套接口最大的坑，三个方向**互不相同**，务必别"统一"：
 *
 *   setCookie     入参是 **CEF 大写** `{Domain,Path,Url,Name,Value}`
 *                 （SDK 里 `Dt` 的逆向映射：小写→大写，且**只认小写输入**）
 *   getFullCookies 返回值必须 **CEF 大写** `{Name,Value,Domain,Path,…}`
 *                 （SDK 里 `Dt` 再把它映射回小写给业务用）
 *   getCookies    返回值是 **对象映射** `{ name: value }`
 *                 （前端 `for (let n in t) …` 遍历，给数组/字符串都会炸）
 *
 * ── 血案记录（2026-09-18）────────────────────────────────────────────
 * 本文件原先三个 handler 一律按**小写**读 `o.url / o.name / o.value`，
 * 而 SDK 传进来的是大写。`o.name` 恒为 undefined → `if (o.name && …)` 永不成立
 * → **每一次写 cookie 都是静默 no-op**，罐子永远是空的。
 *
 * 连锁反应极其隐蔽（全程零报错）：
 *   browser.setCookie 静默失败
 *     → Cookie.getAll 恒返回 []
 *     → app.chunk 的 host/createAnonimous 走到
 *         `const o = yield Cookie.getAll({url}); if (!o || !o.length) return;`
 *       直接静默 return，**uid 永远拿不到、createAnonimousFailed 也不会置 true**
 *     → page:essential / page:homePage 的 fetchBlocksData 开头那道闸门
 *         `if (!v.uid && !v.createAnonimousFailed) return;`
 *       于是永远关闭
 *     → 首页/精选的推荐区块一个请求都不发，页面只有 banner 和空壳
 *
 * 之所以难查：网络层完全正常（/eapi/register/anonimous 明明 200 且回了 userId），
 * 页面也不报错，靠抓包只能看到"该发的请求没发"。真正的证据在**桥接层 trace** 里：
 *     → browser.setCookie [{Domain:"music.163.com",…,Name:"os",Value:"pc"}]
 *     ← browser.setCookie []
 *     → browser.getFullCookies ["https://music.163.com"]
 *     ← browser.getFullCookies [[]]        ← 写完立刻读，还是空
 * 两句一对比就知道是"写了读不回来"，而不是"没人写"。
 * ─────────────────────────────────────────────────────────────────
 */
import createLogger from "../../logger.js";

const log = createLogger("call:browser");

/** 默认域：官方前端所有 cookie 都落在 music.163.com 下 */
const DEFAULT_URL = "https://music.163.com/";

/**
 * 把"任意形态的 cookie 参数"归一成 `{ url, name, value, domain, path }`。
 *
 * 支持四种形态，因为 SDK 在不同方法上用不同风格调用：
 *   - CEF 大写对象：{Domain,Path,Url,Name,Value}   （setCookie）
 *   - 小写对象：    {domain,path,url,name,value}   （业务层直传）
 *   - JSON 字符串  ：'{"name":"…","value":"…"}'    （个别走 SDK 序列化的路径）
 *   - 位置参数      ：(url, name)                  （removeCookie）
 */
function normCookie(a, b) {
  const o =
    typeof a === "string"
      ? (() => {
          const s = a.trim();
          if (s.startsWith("{")) {
            try {
              return JSON.parse(s);
            } catch {
              /* 不是 JSON，当纯 url 处理 */
            }
          }
          return { url: a, name: b };
        })()
      : a || {};

  // 取值时大小写都试：CEF 用大写，我们自己的调用点用的小写
  const pick = (...keys) => {
    for (const k of keys) if (o[k] !== undefined && o[k] !== "") return o[k];
    return undefined;
  };

  return {
    url: String(pick("Url", "url") || DEFAULT_URL),
    name: pick("Name", "name", "key"),
    value: pick("Value", "value"),
    domain: pick("Domain", "domain"),
    path: pick("Path", "path") || "/",
    // 位置参数形态：(url, name)，第二个参数是名字
    bareName: typeof b === "string" ? b : undefined,
    raw: o,
  };
}

export function makeBrowserCalls(ctx) {
  const jar = () => ctx.cookies();

  /** 罐内 → CEF 大写形态（getFullCookies 用，前端会再映射回小写） */
  const toCefCookie = (c) => ({
    Name: c.Name,
    Value: c.Value,
    Domain: c.Domain || "",
    Path: c.Path || "/",
    /**
     * Url 别留空：官方有些地方拿 `cookie.url` 当"这条 cookie 属于哪个站点"用，
     * 空字符串会让后续按 url 归类的逻辑把它归到"无主"，写回罐子时 Domain 也丢了。
     */
    Url: c.Url || (c.Domain ? `https://${String(c.Domain).replace(/^\./, "")}${c.Path || "/"}` : ""),
    HostOnly: !c.Domain,
    Secure: !!c.Secure,
    HttpOnly: !!c.HttpOnly,
    /**
     * ⚠️ 必须是**秒级 unix 时间戳**（数字）。
     * 前端 `parseInt(Expires, 10)` 之后才比较，传 Date / ISO 字符串会被
     * `parseInt` 截成年份（2027）×1000 → 1970 → 判定"已过期"而被丢弃。
     * 详见 cookiejar.js 里 `toEpochSeconds` 的注释。
     */
    Expires: typeof c.Expires === "number" && Number.isFinite(c.Expires) ? c.Expires : null,
    HasExpires: typeof c.Expires === "number" && Number.isFinite(c.Expires),
    SameSite: c.SameSite || null,
  });

  return {
    /** 对象映射形态：{ MUSIC_U: "xxx", __csrf: "yyy" } */
    "browser.getCookies": (url) => {
      const list = jar().list(String(url || DEFAULT_URL));
      const map = {};
      for (const c of list) if (c.Name) map[c.Name] = c.Value;
      log.debug(`getCookies ${url} → ${Object.keys(map).length} 条`);
      return [map];
    },

    /** 数组形态，元素带大写 Name/Value/Domain/Path（SDK 的 `Dt` 认大写） */
    "browser.getFullCookies": (url) => {
      const list = jar().list(String(url || DEFAULT_URL));
      const out = list.filter((c) => c.Name).map(toCefCookie);
      if (!out.length) log.info(`getFullCookies ${url} → 0 条（罐内共 ${jar().size()} 条）`);
      else log.debug(`getFullCookies ${url} → ${out.length} 条`);
      return [out];
    },

    /**
     * 写 cookie。
     * ⚠️ 入参是 CEF 大写对象 —— 见文件头"血案记录"。
     * 拼 Set-Cookie 行时把 Domain/Path 一并带上，否则 tough-cookie 会
     * 按 host-only 存，换个子域（interfacepc.music.163.com）就读不到了。
     */
    "browser.setCookie": (arg) => {
      const c = normCookie(arg);
      const name = c.name || c.bareName;
      if (!name) {
        log.warn(`setCookie 缺少 name，已忽略: ${JSON.stringify(c.raw).slice(0, 160)}`);
        return [];
      }
      if (c.value === undefined) {
        log.warn(`setCookie ${name} 缺少 value，已忽略`);
        return [];
      }
      // Domain 缺省时从 url 推，保证跨子域可见（os/deviceId 这批要跟着每个接口走）
      const host = (() => {
        try {
          return new URL(c.url.startsWith("http") ? c.url : `https://${c.url}`).hostname;
        } catch {
          return "music.163.com";
        }
      })();
      const domain = (c.domain || host).replace(/^\./, "");
      const line = `${name}=${c.value}; Path=${c.path || "/"}; Domain=${domain}`;
      jar().set(c.url, line);
      ctx.saveCookies();
      log.debug(`setCookie ${name}@${domain}`);
      return [];
    },

    /** 删 cookie：SDK 是位置参数 `(url, name)`，不在位置参数时兼容对象形态 */
    "browser.removeCookie": (arg, nameArg) => {
      const c = normCookie(arg, nameArg);
      const name = c.bareName || c.name;
      if (name) {
        jar().remove(c.url, name);
        ctx.saveCookies();
        log.debug(`removeCookie ${name}`);
      }
      return [];
    },

    "browser.flushStore": () => {
      ctx.saveCookies();
      return [];
    },
  };
}

export default makeBrowserCalls;
