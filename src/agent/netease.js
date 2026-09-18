/**
 * Agent 侧乐库客户端（eapi）
 * ============================
 * AI 通过 /agent/* 找歌、下载时，服务端直接调官方接口。
 * 加解密走 src/crypto/eapi.js 的 `eapiParams` / `eapiDecryptResponse`
 * （已实测对齐官方，见该文件头注释）。
 *
 * 请求形态照抄反代层验证过的组合（src/proxy/frontend.js）：
 *   POST https://interface.music.163.com/eapi/<api>
 *   body: params=<hex>
 *   头:  PC 客户端 UA + Referer + cookie（登录态从会话罐里取）
 *
 * ⚠️ eapi 加密用的路径是 `/api/...` 前缀，POST 的 URL 是 `/eapi/...` 前缀 ——
 *   两者别搞混，加密路径写错只会得到 200 + 空 body（网易的老传统）。
 */
import config from "../config.js";
import createLogger from "../logger.js";
import { eapiParams, eapiDecryptResponse } from "../crypto/eapi.js";

const log = createLogger("agent:netease");

const HOST = "https://interface.music.163.com";
const PC_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Netease_Music PC 3.1.34.205281";

/** 客户端自报家门的 cookie（官方 PC 端每次请求都会带） */
const CLIENT_COOKIE = "os=pc; appver=3.1.34.205281; osver=Microsoft-Windows-10--";

/**
 * 合并罐里的 cookie 与客户端自报字段（罐里已有的不覆盖）。
 */
function mergeCookie(jarHeader) {
  const parts = [];
  const seen = new Set();
  for (const seg of [jarHeader || "", CLIENT_COOKIE]) {
    for (const kv of seg.split(";")) {
      const t = kv.trim();
      if (!t) continue;
      const k = t.split("=")[0].toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      parts.push(t);
    }
  }
  return parts.join("; ");
}

/** 判断登录态：罐里有 MUSIC_U（网易登录后的核心凭据） */
export function isLoggedIn(cookieJar) {
  if (!cookieJar) return false;
  try {
    return /(?:^|;\s*)MUSIC_U=[^;\s]+/.test(
      cookieJar.getHeader("https://music.163.com") || ""
    );
  } catch {
    return false;
  }
}

/**
 * 发一个 eapi 请求并解析响应。
 *
 * @param {import("../bridge/cookiejar.js").SessionCookies|null} cookieJar 会话罐（null = 匿名）
 * @param {string} apiPath  形如 "/api/search/pc"
 * @param {object} params   业务参数
 * @returns {Promise<object>} 解析后的响应 JSON
 */
export async function eapiCall(cookieJar, apiPath, params) {
  const url = `${HOST}/eapi${apiPath.slice(4)}`; // /api/x → /eapi/x
  const body = `params=${eapiParams(apiPath, JSON.stringify(params))}`;
  const cookie = mergeCookie(cookieJar ? cookieJar.getHeader(url) : "");

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "user-agent": PC_UA,
        referer: "https://music.163.com/",
        cookie,
      },
      body,
      signal: AbortSignal.timeout(config.requestTimeout),
    });
  } catch (e) {
    throw new Error(`乐库接口连不上: ${e.message}`);
  }
  if (!res.ok) throw new Error(`乐库接口 HTTP ${res.status} (${apiPath})`);

  const raw = Buffer.from(await res.arrayBuffer());
  // e_r 请求的响应是 AES 密文；但业务错误（-462 风控之类）上游会回**明文 JSON**，
  // 两种都要认 —— 先试解密，解不开再看是不是明文 JSON。
  let plain = eapiDecryptResponse(raw);
  if (!plain) {
    const text = raw.toString("utf8");
    if (/^\s*[{[]/.test(text)) {
      plain = text;
    } else {
      throw new Error(`响应解密失败（${raw.length}B，检查 eapi 加密路径是否为 ${apiPath}）`);
    }
  }
  let json;
  try {
    json = JSON.parse(plain);
  } catch {
    throw new Error(`响应不是 JSON: ${plain.slice(0, 120)}`);
  }
  if (json && typeof json.code === "number" && json.code !== 200) {
    const msg = json.message || json.msg || json.blockText || "";
    const err = new Error(`乐库接口业务错误 code=${json.code}${msg ? `（${msg}）` : ""} (${apiPath})`);
    err.code = json.code;
    err.payload = json;
    throw err;
  }
  return json;
}

/* ────────────────────────── 字段归一化 ────────────────────────── */

/** fee 字段语义：0/8=免费（8 是低音质免费），1=VIP，4=数字专辑 */
export function feeTextOf(fee) {
  if (fee === 1) return "vip";
  if (fee === 4) return "album";
  return "free";
}

/** 歌曲详情 / 搜索结果 → agent 友好形状。
 *  ⚠️ 两套字段命名：/api/search/pc 用旧命名（artists/album/duration），
 *  /api/v3/song/detail 用 v3 短命名（ar/al/dt）——不兼容就会得到「未知 - 歌名」。
 */
export function formatSong(s) {
  if (!s || typeof s !== "object") return null;
  return {
    id: s.id,
    name: String(s.name || "").trim(),
    artists: (s.artists || s.ar || []).map((a) => a && a.name).filter(Boolean),
    album: (s.album && s.album.name) || (s.al && s.al.name) || "",
    durationMs: Number(s.duration) || Number(s.dt) || 0,
    fee: Number(s.fee) || 0,
    feeText: feeTextOf(s.fee),
    freeTrial: !!s.freeTrialInfo,
  };
}

/** 歌名文件名安全化（Windows + NAS 通用黑名单） */
export function safeName(s) {
  const out = String(s ?? "")
    .replace(/[\\/:*?"<>|\r\n]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return out.slice(0, 120) || "未知";
}

/* ────────────────────────── 业务接口 ────────────────────────── */

/**
 * 搜歌（单曲）。eapi /api/search/pc，与官方 PC 客户端搜索同一端点。
 * 匿名可调（无需登录）。
 */
export async function searchSongs({ cookieJar, keyword, limit = 20, offset = 0 }) {
  const json = await eapiCall(cookieJar, "/api/search/pc", {
    s: String(keyword || ""),
    type: 1,
    limit: Math.min(100, Math.max(1, Number(limit) || 20)),
    offset: Math.max(0, Number(offset) || 0),
  });
  const r = json.result || {};
  const songs = (r.songs || []).map(formatSong).filter(Boolean);
  return {
    keyword: String(keyword || ""),
    total: Number(r.songCount) || songs.length,
    offset: Number(offset) || 0,
    count: songs.length,
    songs,
  };
}

/**
 * 歌曲详情（下载时只传了 songId 用来补歌名/歌手）。eapi /api/v3/song/detail。
 */
export async function getSongDetail({ cookieJar, id }) {
  const json = await eapiCall(cookieJar, "/api/v3/song/detail", {
    c: JSON.stringify([{ id: Number(id) }]),
    ids: JSON.stringify([Number(id)]),
  });
  return formatSong((json.songs || [])[0]);
}

/**
 * 取音源直链。eapi /api/song/enhance/player/url。
 *
 * 登录态决定能拿到什么：
 *   - 匿名：免费歌通常给 128k 试听直链；VIP 歌给 30s 试听片段（freeTrialInfo 非空）
 *   - 登录 + VIP 账号：320k/无损（视 br 与账号权限）
 *
 * @returns {{id,url,br,size,md5,type,fee,level,freeTrial,freeTrialMs}}
 */
export async function getSongUrl({ cookieJar, id, br = 320000 }) {
  const json = await eapiCall(cookieJar, "/api/song/enhance/player/url", {
    ids: [Number(id)],
    br: Number(br) || 320000,
  });
  const d = (json.data || [])[0];
  if (!d) {
    const err = new Error(`没有音源数据（songId=${id}，可能无版权）`);
    err.code = 404;
    throw err;
  }
  const ft = d.freeTrialInfo || null;
  return {
    id: d.id,
    url: String(d.url || ""),
    br: Number(d.br) || 0,
    size: Number(d.size) || 0,
    md5: String(d.md5 || ""),
    type: String(d.type || "mp3").toLowerCase(),
    fee: Number(d.fee) || 0,
    level: String(d.level || ""),
    freeTrial: !!ft,
    freeTrialMs: ft ? (Number(ft.end) || 0) - (Number(ft.start) || 0) : 0,
  };
}

export default { eapiCall, searchSongs, getSongDetail, getSongUrl, isLoggedIn, formatSong, feeTextOf, safeName };
