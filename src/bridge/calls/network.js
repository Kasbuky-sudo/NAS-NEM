/**
 * network.* —— 宿主级网络请求
 * =============================
 * 官方前端把一部分请求交给原生发（带设备头、绕 CORS）：
 *   - `network.fetch({url, method, headers, body, ...})`
 *   - `network.getEnv` / `network.init` / `network.getNetworkQuality` / `network.diagnostic`
 *
 * Web 版本里绝大多数请求已经被 `/__p/` 同源反代接走，但 `network.fetch` 仍然要能跑通，
 * 否则那些走桥的请求会静默失败。这里直接复用同一个白名单代理逻辑。
 */
import createLogger from "../../logger.js";
import config from "../../config.js";

const log = createLogger("call:network");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function hostAllowed(host) {
  const h = String(host).toLowerCase();
  return config.allowedApiHosts.some((s) => h === s || h.endsWith("." + s));
}

function normalize(opts, url) {
  if (opts && typeof opts === "object" && opts.url) return opts;
  return { url, method: "GET" };
}

export function makeNetworkCalls(ctx) {
  return {
    /**
     * @param opts {url, method, headers, data|body, timeout, noCookie}
     * 返回 [statusCode, bodyText] —— 与官方约定一致（前端自己 JSON.parse）
     */
    "network.fetch": async (opts, maybeUrl) => {
      const o = normalize(opts, maybeUrl);
      let target = o.url || maybeUrl;
      if (!target) return [0, ""];

      // 前端可能给的是 /__p/... 或裸 https://music.163.com/...
      let abs;
      try {
        abs = /^https?:/i.test(target) ? new URL(target) : new URL(target, ctx.origin);
      } catch {
        return [0, `bad url: ${target}`];
      }
      if (abs.pathname.startsWith("/__p/")) {
        const rest = abs.pathname.slice("/__p/".length);
        const h = rest.slice(0, rest.indexOf("/"));
        abs = new URL(`https://${h}${rest.slice(h.length)}${abs.search}`);
      }
      if (!hostAllowed(abs.hostname)) {
        log.warn(`network.fetch 拒绝非白名单域名: ${abs.hostname}`);
        return [0, "host not allowed"];
      }

      const headers = { "user-agent": UA, referer: "https://music.163.com/" };
      if (o.headers && typeof o.headers === "object") {
        for (const [k, v] of Object.entries(o.headers)) headers[k.toLowerCase()] = String(v);
      }
      if (!o.noCookie) {
        const jar = ctx.cookies();
        const c = jar.getHeader(abs.href);
        if (c) headers.cookie = c;
      }

      const method = (o.method || "GET").toUpperCase();
      const body = o.data ?? o.body;
      if (method !== "GET" && method !== "HEAD" && body !== undefined && body !== null) {
        headers["content-type"] = headers["content-type"] || "application/x-www-form-urlencoded";
      }

      try {
        const res = await fetch(abs, {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
          redirect: "follow",
          signal: AbortSignal.timeout(o.timeout || config.requestTimeout),
        });
        const text = await res.text();

        // 回写 cookie，保证登录态在桥与代理两条路上一致
        const setCookies = res.headers.getSetCookie?.() ?? [];
        if (setCookies.length) {
          const jar2 = ctx.cookies();
          for (const sc of setCookies) jar2.set(abs.href, sc);
          ctx.saveCookies();
        }
        return [res.status, text];
      } catch (e) {
        log.warn(`network.fetch 失败 ${abs.hostname}${abs.pathname} → ${e.message}`);
        return [0, e.message];
      }
    },

    "network.init": () => [],
    "network.getEnv": () =>
      [
        JSON.stringify({
          Type: "native",
          native: { netType: 1, dns: "223.5.5.5" },
          http: null,
          https: null,
        }),
      ],
    "network.getNetworkQuality": () => [JSON.stringify({ level: 4, rtt: 20, lost: 0 })],
    "network.diagnostic": () => [JSON.stringify({ ok: true })],
    "network.nativeTypeReportPercent": 0,
    "network.normalTypeReportPercent": 0,
  };
}

export default makeNetworkCalls;
