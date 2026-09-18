/**
 * 前端文件改写层
 * =================
 * 官方前端是从 `orpheus.ntpk` 里解出来的静态文件，直接原样吐出去**基本**能跑
 * （`orpheus://` 由 web/shim.js 在运行时改写），但有三处必须动手术：
 *
 *  1. `isMainWindow` —— 官方用它判断"我是主窗口还是子窗口"，算法是
 *         isMainWindow: !!isWeb || "orpheus://orpheus/pub/app.html" === window.location.href
 *     浏览器里 location.href 永远是 http(s) 全量地址，这个比较**恒为 false**，
 *     而 isMainWindow 挂着主路由注册、全局 dispatch、起始任务编排。为 false 就直接白屏。
 *     → 改写成读 `window.__NASNEM_IS_MAIN__`（由 shim 依据路径判定，子窗口仍会得到 false）。
 *
 *  2. CSP —— 官方 app.html 的 `connect-src` 是一串 `orpheus://…`，在浏览器里这些
 *     源表达式非法，会把我们的 `/orpheus/*` 请求全部拦死。
 *     这里换成一份自托管场景下够用的宽松 CSP（保留 unsafe-eval，官方前端要用），
 *     并用 `frame-ancestors` 表达"允许被谁嵌入"（见下面的 FRAME_ANCESTORS）。
 *
 *  3. 注入 shim —— 必须在所有 bundle 之前同步执行，所以塞在 <head> 最前面。
 */
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

import config, { ROOT } from "../config.js";
import createLogger from "../logger.js";

const log = createLogger("rewrite");

const SHIM_PATH = join(ROOT, "web", "shim.js");
let shimSrc = null;
let warnedNoPatch = false;
/** 「封面协议前缀已改写」只报一次，免得 46 个 chunk 刷屏 */
let patchedCacheProto = false;

export async function loadShim() {
  if (shimSrc === null) shimSrc = await readFile(SHIM_PATH, "utf8");
  return shimSrc;
}

/** 自托管用 CSP：外部资源（网易 CDN / 易盾 / unpkg）都要放行 */
/**
 * 飞牛页内打开（`ui/config` 的 `type: "iframe"`）时，桌面跑在 `:5666`、
 * 应用跑在 `:8163` —— **端口不同即跨源**，而应用自己的服务端如果发
 * `X-Frame-Options: SAMEORIGIN`，浏览器会直接把整个 iframe 拒绝渲染，
 * 表现为「页内打开一片空白，切到新标签页打开却完全正常」。
 *
 * `X-Frame-Options` 只有 DENY / SAMEORIGIN 两个取值，**表达不了"放行某个跨源祖先"**，
 * 所以正确的做法是：服务端不发 `X-Frame-Options`，把白名单交给 CSP 的
 * `frame-ancestors`。
 *
 * ⚠️ 这里只能用 scheme-source（`http:` / `https:`），不能写 `https://` 这种带双斜杠的
 * 绝对源 —— 项目里有一条"CSP 不得出现绝对源"的约束，而且 scheme-source 本就更合适：
 * 飞牛桌面既可能跑在 http，也可能跑在 https，且用户访问用的 hostname 不定。
 */
export const FRAME_ANCESTORS = "frame-ancestors 'self' http: https:";

export function cspWithFrameAncestors(csp) {
  return csp.includes("frame-ancestors") ? csp : `${csp}; ${FRAME_ANCESTORS}`;
}

const CSP_BASE =
  "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; " +
  "script-src * data: blob: 'unsafe-inline' 'unsafe-eval'; " +
  "style-src * data: blob: 'unsafe-inline'; " +
  "img-src * data: blob:; " +
  "media-src * data: blob:; " +
  "font-src * data:; " +
  "connect-src * data: blob:; " +
  "frame-src * data: blob:; " +
  "object-src 'none'";

const CSP = cspWithFrameAncestors(CSP_BASE);

/** 主窗口判定替换：把恒 false 的比较换成 shim 提供的开关 */
const IS_MAIN_RE =
  /isMainWindow:\s*!![\w$]+\.isWeb\s*\|\|\s*""\.concat\([\w$]+\s*,\s*"app\.html"\)\s*===\s*window\.location\.href/g;
/** 只带 concat 半截的形态（没有 `!!isWeb ||` 前缀） */
const IS_MAIN_CONCAT_RE = /""\.concat\([\w$]+\s*,\s*"app\.html"\)\s*===\s*window\.location\.href/g;
/** 最后的兜底：连 concat 都没有，只剩裸比较（html 内联脚本里偶见） */
const IS_MAIN_FALLBACK_RE = /"app\.html"\)\s*===\s*window\.location\.href/g;

const IS_MAIN_VALUE = "window.__NASNEM_IS_MAIN__!==!1";

/**
 * 首页加载链路探针（NASNEM_DEBUG_HOMEPAGE=1 时才注入）
 * --------------------------------------------------
 * `page:homePage` 的 `fetchBlocksData` effect 开头有一道静默闸门：
 *     const e = yield a(n.j);
 *     if (!e) return void (yield o({type:"onUpdate",payload:{enableRecommend:e,...}}));
 * 闸门关着时**不抛错、不打日志、不发请求**，从外部看就是"首页下半截空白"。
 * 这两处注入能把"没被 dispatch"和"被闸门挡了"区分开。
 */
const HP_ENTER_RE = /effects:\{fetchBlocksData\(e,t\)\{/g;
const HP_GATE_RE = /const e=yield a\(n\.j\);if\(!e\)return/g;

/**
 * ⚠️ 探针一律写进 `window.__NASNEM_PROBE__` 数组，**不要依赖 console.log**。
 *
 * 为什么改：第一版探针用 console.log，结果一条都读不到，差点得出"效应没跑"的
 * 错误结论。三个原因叠在一起：
 *   1. 页面自身日志（Canvas2D / APM / schema）会把启动早期的输出淹掉，
 *      而抓包工具默认只留末尾若干条；
 *   2. 官方前端有可能替换 `console`（它有 `app.log` 那套原生日志），
 *      一旦 console.log 被换成普通 JS 函数，CDP 的 consoleAPICalled **不再触发**；
 *   3. 探针都在启动早期打，而人往往十几秒后才回头看。
 * 数组方案绕开全部三个：读的时候直接 evaluate 数组，顺序完整、不丢条目。
 *
 * ⚠️ 另一个坑：注入的语句**结尾必须是分号**（除纯表达式场景）。
 * 曾经用逗号收尾 → `console.log(...),let{payload:l}=e`，
 * `let` 不能出现在逗号表达式右边 → 整个 chunk 语法错误、首页连 banner 都不渲染。
 */
/**
 * 自托管环境里没有"窗口"这回事，官方标题栏右侧那排窗口控制按钮
 * （mini 模式 / 最小化 / 最大化 / 关闭）点了只会走 `WindowHelper.*` 桥调用，
 * 在网页里要么没反应要么干脆报错 —— 纯属占地方。
 *
 * 用 `[class*=]` 匹配而不是写死完整类名：styled-components 的类名是
 * `WindowOpBarContainer_wogxdm7` 这种"语义前缀_构建哈希"形态，换包就变，
 * 但语义前缀稳定。`:has()` 把紧挨着它的那条分隔线也一并藏掉，
 * 免得"换肤 |"后面悬一根孤零零的竖线。
 */
const WINDOW_CONTROL_CSS = `
<style>
  [class*="WindowOpBarContainer"],
  [class*="Divider"]:has(+ [class*="WindowOpBarContainer"]) {
    display: none !important;
  }
</style>
`;

function np(expr) {
  return `(window.__NASNEM_PROBE__=window.__NASNEM_PROBE__||[]).push(${expr})`;
}

const HP_ENTER_TO = `effects:{fetchBlocksData(e,t){${np('"19:fetchBlocksData dispatched"')};`;
const HP_GATE_TO = `const e=yield a(n.j);${np('"19:enableRecommend="+e')};if(!e)return`;

/**
 * 31.chunk 里的首页**挂载效应**——真正决定"要不要去拉区块数据"的地方。
 *
 * ⚠️ 这个文件里有**两套**首页组件，长得几乎一样，千万别只改一套：
 *
 *   A. 旧版（约 @220127，本地缓存 key `"homePage"`）
 *      → dispatch `page:homePage/fetchBlocksData`
 *      → 19.chunk 里那个带 `enableRecommend` 静默闸门的 effect 就是它。
 *
 *   B. 新版 / ECPM（约 @267057，本地缓存 key `"homePageEcpm"`）
 *      → dispatch `page:homePage/fetchHomePageAllResourceDatas`
 *      → 它还拿着 `homePageEcpmOrderedBlocks` 决定区块顺序
 *        （用 `["featureRecommendBlock","recommendPlaylistBlock","bannersBlock"]`
 *          补进列表，所以首页区块的**顺序和取舍由这里说了算**）。
 *
 * 两套控制流一模一样，坑也一样：
 *   Object(aa.a)(async()=>{
 *     if(!Object.keys(缓存state||{}).length){
 *       const e = await Object(na.k)("homePage"/"homePageEcpm",!0);  // ← 读本地磁盘缓存
 *       命中 → 用缓存，isRenderByServer=!1；没命中 → isRenderByServer=!0（不抛错）
 *       K(!1) / z(!1)                                                // ← 关骨架屏
 *     }
 *     S.current || dispatch(...), S.current=!0     // useRef(false)，只 dispatch 一次
 *   }, deps)
 *
 * 三个要点：
 *  1. `S.current`/`x.current` 是 useRef(false)，`||` 只让 dispatch 发生**一次**；
 *     紧接着无条件置 true —— **第一次跑歪了就再也不会重试**。
 *  2. 关骨架屏的 `K(!1)`/`z(!1)` 在 `if` 里面。上面那段 await / 比较一旦抛错，
 *     骨架屏就**永远关不掉**。
 *  3. 整个 async 体没有 try/catch，而外层 `aa.a` 可能吞掉异常 ——
 *     外部表现是"什么都没发生"，`unhandledrejection` 也就抓不到。所以这里自己包一层。
 */
const P_CACHE_MAIN = np(
  '"31:cache(main)="+(e===undefined?"undefined":e===null?"null":typeof e==="object"?("uid="+e.uid+" keys=["+Object.keys(e).slice(0,14).join("|")+"]"):String(e))'
);
const P_CACHE_ECPM = np(
  '"31:cache(ecpm)="+(e===undefined?"undefined":e===null?"null":typeof e==="object"?("uid="+e.uid+" keys=["+Object.keys(e).slice(0,14).join("|")+"]"):String(e))'
);

const HP31_PROBES = [
  // ── A. 旧版首页组件 ──────────────────────────────────────────
  [
    ">=4;Object(aa.a)(async()=>{if(!Object.keys(W||{}).length){",
    `>=4;Object(aa.a)(async()=>{${np('"31:enter(main)"')};try{if(!Object.keys(W||{}).length){`,
  ],
  [
    'const e=await Object(na.k)("homePage",!0);',
    `const e=await Object(na.k)("homePage",!0);${P_CACHE_MAIN};`,
  ],
  [
    "},[o,c,r,W,U])",
    `}catch(__npe1){${np('"31:THREW(main)="+((__npe1&&(__npe1.stack||__npe1.message))||String(__npe1))')}}},[o,c,r,W,U])`,
  ],
  [
    'S.current||a({type:"page:homePage/fetchBlocksData"})',
    `${np('"31:gate(main) S.current="+S.current')},S.current||a({type:"page:homePage/fetchBlocksData"})`,
  ],

  // ── B. 新版 / ECPM 首页组件 ─────────────────────────────────
  [
    "Object(aa.a)(async()=>{if(!Object.keys(L||{}).length){",
    `Object(aa.a)(async()=>{${np('"31:enter(ecpm)"')};try{if(!Object.keys(L||{}).length){`,
  ],
  [
    'const e=await Object(na.k)("homePageEcpm",!0);',
    `const e=await Object(na.k)("homePageEcpm",!0);${P_CACHE_ECPM};`,
  ],
  [
    "},[a,i,l,C])",
    `}catch(__npe2){${np('"31:THREW(ecpm)="+((__npe2&&(__npe2.stack||__npe2.message))||String(__npe2))')}}},[a,i,l,C])`,
  ],
  [
    'x.current||n({type:"page:homePage/fetchHomePageAllResourceDatas"})',
    `${np('"31:gate(ecpm) x.current="+x.current')},x.current||n({type:"page:homePage/fetchHomePageAllResourceDatas"})`,
  ],
];

/** 首页相关的懒加载 chunk；只在命中这些文件时才走上面的注入 */
function isHomepageChunk(path) {
  return /\/hybrid\/19\.chunk[.\w-]*js$/.test(path.replace(/\\/g, "/"));
}

/** 31.chunk 里那段"首页挂载效应"所在的文件 */
function isHomeMountChunk(path) {
  return /\/hybrid\/31\.chunk[.\w-]*js$/.test(path.replace(/\\/g, "/"));
}

/* ─────────────────── 匿名用户链路探针 ───────────────────
 *
 * 为什么值得单独埋点：整条"首页/精选拿不到数据"的根因都收敛在匿名身份的建立上。
 * 前一道坎（`browser.setCookie` 字段大小写写错导致罐子恒空）已经修掉，
 * 但它只解决了 `createAnonimous` 里的**第一道**静默 return；
 * 后面还有 `Cookie.getAll` → 持久化 → `Object(j.d)("createAnonimous")` → `switchUser`
 * 四步，任何一步悄悄失败，外部表现都一模一样（页面不报错、就是不请求数据）。
 *
 * 这几行探针把每一步的中间值写进 `window.__NASNEM_PROBE__`，
 * 一次冒烟就能定位到底卡在哪一步，不用再来回猜。
 */
const ANON_COOKIE_RE = /if\(null===o\|\|void 0===o\|\|!o\.length\)return;/;
const ANON_COOKIE_TO = `if(null===o||void 0===o||!o.length){${np('"anon:GATE cookies=0 → 静默 return"')};return}${np(
  '"anon:cookies="+o.length+" names=["+o.map(function(c){return c.name}).join("|")+"]"'
)};`;

const ANON_HOST_RE = /const a=yield Object\(j\.d\)\("createAnonimous"\);/;
const ANON_HOST_TO = `const a=yield Object(j.d)("createAnonimous");${np(
  '"anon:host uid="+(a&&a.uid)+" keys="+(a?Object.keys(a).join("|"):"null")'
)};`;

const ANON_FAIL_RE = /_\.b\.warn\("host","createAnonimous","failed to create anonimous user",e\)/;
const ANON_FAIL_TO = `_.b.warn("host","createAnonimous","failed to create anonimous user",e),${np(
  '"anon:CATCH "+(e&&(e.message||e))'
)}`;

/** 拿到 uid 之后立刻打点：`if(_.b.info("Host","创建匿名用户","获得Uid",t),!t)return;` */
const ANON_UID_RE = /if\(_\.b\.info\("Host","\\u521b\\u5efa\\u533f\\u540d\\u7528\\u6237","\\u83b7\\u5f97Uid",t\),!t\)return;/;
const ANON_UID_TO = `if(_.b.info("Host","\\u521b\\u5efa\\u533f\\u540d\\u7528\\u6237","\\u83b7\\u5f97Uid",t),${np('"anon:uid t="+t')},!t)return;`;

/**
 * `getHostForLogin`（app.chunk 里 `L=async e=>{...}`）内部打点。
 *
 * 它有两条出路，都要 MUSIC_A：
 *   路径A（已登录）：`r = y.get()` 且 `l = b.get()` 里有 MUSIC_A/MUSIC_U → 返回 r
 *   路径B（匿名）  ：`c = v.get()` 且 `s = h.get()` 里有 MUSIC_A          → 返回 c
 *   否则           ：`v.delete(), h.delete(), {}`  ← 屏幕一片空白的元凶
 *
 * 光看返回值 `{}` 分不清是"c 没 uid"还是"s 里没 MUSIC_A"，
 * 所以把四个存储的实际内容全打出来。
 */
const HOST_LOGIN_RE = /const c=await v\.get\(\);let s=await h\.get\(\);/;
const HOST_LOGIN_TO = `const c=await v.get();let s=await h.get();${np(
  '"anon:L2 c="+JSON.stringify(c).slice(0,110)+" hasA_s="+!!(s&&Object(o.d)("MUSIC_A",s))'
)},${np(
  '"anon:L2b A_entry="+JSON.stringify((s||[]).filter(function(x){return x.name==="MUSIC_A"})[0]||null).slice(0,150)'
)};`;

/** page:essential 模型的闸门（`if(!v.uid&&!v.createAnonimousFailed)return;`） */
const ESS_GATE_RE = /if\(!v\.uid&&!v\.createAnonimousFailed\)return;/;
const ESS_GATE_TO = `${np('"ess:uid="+(v&&v.uid)+" anonFailed="+(v&&v.createAnonimousFailed)')};if(!v.uid&&!v.createAnonimousFailed){${np(
  '"ess:GATE-BLOCKED（uid 空且未标记失败）"'
)};return}`;

const ESS_ENTER_RE = /effects:\{fetchBlocksData\(e,t\)\{/;
const ESS_ENTER_TO = `effects:{fetchBlocksData(e,t){${np('"ess:fetchBlocksData 已进入"')};`;

const ESS_DONE_RE = /yield a\(\{type:"onUpdate",payload:\{officialPlaylists:t,latestSongs:r,rcmdAudioBooks:o,rcmdVoices:i/;
const ESS_DONE_TO = `${np(
  '"ess:OK playlists="+t.length+" songs="+r.length+" books="+(o?o.length:0)+" voices="+i.length'
)},yield a({type:"onUpdate",payload:{officialPlaylists:t,latestSongs:r,rcmdAudioBooks:o,rcmdVoices:i`;

/** 应用侧自己的日志（`app.log` / `_b.info`）在 shim 里被本地吞掉了，这里抓不到；
 *  所以匿名链路只靠上面的探针。 */
const ANON_PROBES = [
  [ANON_COOKIE_RE, ANON_COOKIE_TO],
  [ANON_HOST_RE, ANON_HOST_TO],
  [ANON_FAIL_RE, ANON_FAIL_TO],
  [ESS_GATE_RE, ESS_GATE_TO],
  [ESS_ENTER_RE, ESS_ENTER_TO],
  [ESS_DONE_RE, ESS_DONE_TO],
  [ANON_UID_RE, ANON_UID_TO],
  [HOST_LOGIN_RE, HOST_LOGIN_TO],
];

function isHostBootChunk(path) {
  return /\/hybrid\/app\.chunk[.\w-]*js$/.test(path.replace(/\\/g, "/"));
}

function isEssentialModelChunk(path) {
  return /\/hybrid\/186\.chunk[.\w-]*js$/.test(path.replace(/\\/g, "/"));
}

/**
 * 给每个 hybrid chunk 最前面插一行"我到过这里"的标记。
 *
 * 为什么需要：探针全是插在**组件体内**的，一旦查不到就分不清两种情况 ——
 *   (a) 组件没渲染；还是 (b) 整个 chunk 压根没被执行 / 标记通道本身坏了。
 * 把标记插在文件最顶层（`(this.webpackJsonp=…).push(...)` 之前），
 * 只要 chunk 被求值就一定留痕，通道是否可用也就一并验证了。
 */
function chunkMarker(path) {
  const m = /\/hybrid\/([A-Za-z0-9_~.-]+?)\.(?:chunk|bundle)[.\w-]*js$/.exec(path.replace(/\\/g, "/"));
  if (!m) return null;
  const name = m[1];
  return `(window.__NASNEM_PROBE__=window.__NASNEM_PROBE__||[]).push("chunk:"+${JSON.stringify(name)});`;
}


const TRANSFORMABLE = new Set([".js", ".mjs", ".html", ".htm"]);

export function transformable(path) {
  return TRANSFORMABLE.has(extname(path).toLowerCase());
}

/**
 * 改写一个前端文件。
 * @param {string} filePath 磁盘路径
 * @param {string} text 原始内容
 * @returns {string}
 */
export function rewriteText(filePath, text) {
  const ext = extname(filePath).toLowerCase();
  let out = text;

  if (ext === ".js" || ext === ".mjs") {
    // chunk 求值标记：必须插在最前面，先于所有其它改写（它在文件顶层）
    if (config.debugHomepage) {
      const mk = chunkMarker(filePath);
      if (mk && !out.startsWith(mk)) out = mk + out;
    }

    const before = out;
    out = out.replace(IS_MAIN_RE, `isMainWindow:${IS_MAIN_VALUE}`);
    if (out === before) {
      // 没有 `!!isWeb ||` 前缀的形态
      out = out.replace(IS_MAIN_CONCAT_RE, IS_MAIN_VALUE);
    }
    if (out === before && IS_MAIN_FALLBACK_RE.test(out)) {
      // 只剩裸比较：左值仍然是拼出来的 orpheus 长地址 → 换成跟入口名比
      out = out.replace(IS_MAIN_FALLBACK_RE, '"app.html"===window.__NASNEM_ENTRY__');
    }

    // 首页探针（默认关闭）
    if (config.debugHomepage && isHomepageChunk(filePath)) {
      const hits = [];
      if (HP_ENTER_RE.test(out)) { HP_ENTER_RE.lastIndex = 0; out = out.replace(HP_ENTER_RE, HP_ENTER_TO); hits.push("enter"); }
      else HP_ENTER_RE.lastIndex = 0;
      if (HP_GATE_RE.test(out)) { HP_GATE_RE.lastIndex = 0; out = out.replace(HP_GATE_RE, HP_GATE_TO); hits.push("gate"); }
      else HP_GATE_RE.lastIndex = 0;
      if (hits.length) log.info(`首页探针已注入 (${hits.join("+")}): ${filePath}`);
    }

    // 31.chunk：首页挂载效应探针（同样默认关闭）
    if (config.debugHomepage && isHomeMountChunk(filePath)) {
      const hits = [];
      for (const [from, to] of HP31_PROBES) {
        if (out.includes(from)) {
          out = out.replace(from, to);
          hits.push(from.slice(0, 24));
        }
      }
      if (hits.length) log.info(`首页挂载探针已注入 (${hits.length}/${HP31_PROBES.length}): ${filePath}`);
      else log.warn(`首页挂载探针一条都没命中，31.chunk 结构可能变了: ${filePath}`);
    }

    // 匿名用户链路探针：app.chunk（host 模型）+ 186.chunk（page:essential 模型）
    if (config.debugHomepage && (isHostBootChunk(filePath) || isEssentialModelChunk(filePath))) {
      const hits = [];
      for (const [re, to] of ANON_PROBES) {
        const src = re.source;
        if (new RegExp(src).test(out)) {
          out = out.replace(new RegExp(src), to);
          hits.push(src.slice(0, 22));
        }
      }
      if (hits.length) log.info(`匿名链路探针已注入 (${hits.length}/${ANON_PROBES.length}): ${filePath}`);
      else log.warn(`匿名链路探针一条都没命中: ${filePath}`);
    }
  }

  /**
   * `orpheus://cache/?` → `/__cache/?`
   *
   * 桌面端给封面图套的自定义协议（CEF 注册，顺带做本地缓存）。浏览器不认
   * 这个 scheme，写进 CSP 也没用（只会 ERR_UNKNOWN_URL_SCHEME），
   * 所以统一换成同源路径，由 `proxy/frontend.js` 的 `handleCache` 代理。
   *
   * 只替换**带引号的字面量**，两处写法都覆盖到：
   *   `e.startsWith("orpheus://cache/?")`
   *   `e.slice("orpheus://cache/?".length)`
   * 替换后 `"/__cache/?".length` 依旧成立，逻辑不用改。
   */
  if (out.includes('"orpheus://cache/?"')) {
    const n = out.split('"orpheus://cache/?"').length - 1;
    out = out.split('"orpheus://cache/?"').join('"/__cache/?"');
    if (!patchedCacheProto) {
      patchedCacheProto = true;
      log.info(`封面协议前缀已改写 orpheus://cache/? → /__cache/? （本次 ${n} 处）`);
    }
  }

  if (ext === ".html" || ext === ".htm") {
    // 1) 干掉官方 CSP meta（connect-src 里的 orpheus:// 会拦死我们）
    out = out.replace(
      /<meta[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi,
      `<meta http-equiv="Content-Security-Policy" content="${CSP}">`
    );
    // 2) 注入 shim（同步、最前）
    const tag = '<script src="/__shim.js"></script>';
    if (out.indexOf("</head>") >= 0) {
      out = out.replace(/<head([^>]*)>/i, (m) => m + "\n" + tag);
    } else {
      out = tag + "\n" + out;
    }
    // 2.5) 网页版没有窗口系统 —— 藏掉标题栏右侧的窗口控制按钮
    out = out.replace(/<\/head>/i, WINDOW_CONTROL_CSS + "</head>");
    // 3) 有些 html 里内联脚本也含那个比较
    out = out.replace(IS_MAIN_CONCAT_RE, IS_MAIN_VALUE);
    out = out.replace(IS_MAIN_FALLBACK_RE, '"app.html"===window.__NASNEM_ENTRY__');
  }

  return out;
}

/**
 * 包装一次"读 + 改写 + 缓存"，供静态服务用。
 * 非改写类型直接返回 Buffer 直通。
 */
const cache = new Map();

export async function readAndRewrite(filePath, mtimeMs) {
  if (!transformable(filePath)) return null;
  const key = filePath;
  const hit = cache.get(key);
  if (hit && hit.mtime === mtimeMs) return hit.buf;

  const raw = await readFile(filePath, "utf8");
  const out = rewriteText(filePath, raw);
  const buf = Buffer.from(out, "utf8");
  if (cache.size > 400) cache.clear();
  cache.set(key, { mtime: mtimeMs, buf });
  return buf;
}

/** 启动自检：确认 isMainWindow 补丁在当前 pack 版本上仍然命中 */
export async function verifyPatch(files) {
  for (const f of files) {
    try {
      const text = await readFile(f, "utf8");
      IS_MAIN_RE.lastIndex = 0;
      IS_MAIN_CONCAT_RE.lastIndex = 0;
      IS_MAIN_FALLBACK_RE.lastIndex = 0;
      if (IS_MAIN_RE.test(text) || IS_MAIN_CONCAT_RE.test(text) || IS_MAIN_FALLBACK_RE.test(text)) {
        log.info(`isMainWindow 补丁命中: ${f}`);
        warnedNoPatch = true;
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  if (!warnedNoPatch) {
    log.warn("未在 bundle 中发现 isMainWindow 比较式 —— 官方包版本可能变了，主窗口判定需要重新适配");
  }
  return false;
}

export default { rewriteText, readAndRewrite, transformable, loadShim, verifyPatch };
