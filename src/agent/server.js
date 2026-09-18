/**
 * Agent API —— 给 AI 用的 HTTP 控制面
 * =====================================
 * P1 范围：找歌（搜索）+ 下载（落盘到下载目录）。播放遥控与签到不做（见可行性评估）。
 *
 * 端点（全部要求 Bearer token，/agent/ping 除外）：
 *   GET    /agent/ping            存活探测（免鉴权，只报 agent 在不在）
 *   GET    /agent/status          服务状态 + 登录态 + 下载目录 + 任务概览
 *   GET    /agent/search          ?keyword=xxx&limit=20&offset=0   找歌
 *   POST   /agent/download        {songId} 或完整 song 对象；可选 br
 *   GET    /agent/download/tasks  任务列表（活跃 + 最近历史）
 *   GET    /agent/download/:id    单任务
 *   DELETE /agent/download/:id    取消任务
 *
 * 鉴权：`Authorization: Bearer <token>`。
 *   - `NASNEM_AGENT_TOKEN` 环境变量优先；
 *   - 未设置则首次启动生成 `nem_...` 并持久化到 `<dataDir>/agent-token`（0600），
 *     启动日志里打印位置 —— token 是唯一口令，别外发。
 *
 * 会话（登录态）选择：调官方接口要带会话罐（MUSIC_U = 已登录账号，
 * MUSIC_A = 匿名登录态，是过网易 -462 风控的最低要求）。优先级：
 *   1. 请求显式 `?sid=<会话id>`
 *   2. multiUser=false 时的固定会话 "shared"
 *   3. 内存在线会话：先已登录的，退而求其次带匿名登录态的
 *   4. 磁盘 users/<sid>/cookies.json：先含 MUSIC_U 的，再含 MUSIC_A 的
 *   5. 都没有 → 空罐兜底（搜索可能被风控拒）
 * 免登录能力边界：匿名态可搜索、可下免费歌完整音源；VIP 歌只有试听片段。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import express, { Router } from "express";

import config, { paths, resolveDownloadDir } from "../config.js";
import createLogger from "../logger.js";
import { randomId, safeJoin } from "../util.js";
import { ensureSession, listSessions } from "../bridge/server.js";
import {
  searchSongs,
  getSongDetail,
  getSongUrl,
  isLoggedIn,
  safeName,
} from "./netease.js";
import { downloadToFile } from "../download/engine.js";

const log = createLogger("agent");

const VERSION = "0.3.0";
const MAX_CONCURRENT = 5;
const HISTORY_LIMIT = 50;
const MUSIC_URL = "https://music.163.com";

/* ────────────────────────── token ────────────────────────── */

function loadOrCreateToken() {
  if (process.env.NASNEM_AGENT_TOKEN) {
    log.info("Agent token 来自 NASNEM_AGENT_TOKEN 环境变量");
    return String(process.env.NASNEM_AGENT_TOKEN);
  }
  const file = join(paths.dataDir, "agent-token");
  try {
    if (existsSync(file)) {
      const t = readFileSync(file, "utf8").trim();
      if (t) return t;
    }
  } catch {
    /* ignore */
  }
  const t = `nem_${randomId(24)}`;
  try {
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(file, `${t}\n`, { mode: 0o600 });
    log.info(`已生成 Agent API token → ${file}`);
  } catch (e) {
    log.error(`agent-token 写入失败: ${e.message}`);
  }
  return t;
}

function makeAuth(expected) {
  const buf = Buffer.from(String(expected));
  return (req, res, next) => {
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
    const given = m ? m[1].trim() : "";
    let ok = false;
    if (given.length === buf.length) {
      try {
        ok = timingSafeEqual(Buffer.from(given), buf);
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      res.status(401).json({
        code: 401,
        error: "unauthorized",
        message:
          "需要 Authorization: Bearer <token>；token 在 NAS 的 <dataDir>/agent-token 或 NASNEM_AGENT_TOKEN，问 NAS 主人拿",
      });
      return;
    }
    next();
  };
}

/* ────────────────────────── 会话选择 ────────────────────────── */

/** 磁盘上有 cookies.json 的会话目录列表（dataDir/users/<sid>/） */
function diskSessionIds() {
  try {
    return readdirSync(paths.users, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** 罐头里有没有某个 cookie（MUSIC_U = 已登录，MUSIC_A = 匿名登录态） */
function jarHeaderOf(ctx) {
  try {
    return String(ctx.cookies().getHeader("https://music.163.com") || "");
  } catch {
    return "";
  }
}

async function resolveAgentSession(req) {
  // 1. 显式 sid
  const explicit = String(req.query.sid || "");
  if (/^[A-Za-z0-9_-]{4,64}$/.test(explicit)) {
    const ctx = await ensureSession(explicit);
    return { ctx, pickedBy: "explicit" };
  }
  // 2. 单用户模式
  if (!config.multiUser) {
    return { ctx: await ensureSession("shared"), pickedBy: "shared" };
  }
  // 3. 内存在线会话里挑：先已登录的（MUSIC_U），退而求其次带匿名登录态的
  //    （MUSIC_A/deviceId 是过网易 -462 风控的最低要求，空罐连搜索都会被拒）
  let onlineAnon = null;
  for (const ctx of listSessions()) {
    const head = jarHeaderOf(ctx);
    if (/(?:^|;\s*)MUSIC_U=[^;\s]+/.test(head)) return { ctx, pickedBy: "online" };
    if (!onlineAnon && /(?:^|;\s*)MUSIC_A=[^;\s]+/.test(head)) onlineAnon = ctx;
  }
  if (onlineAnon) return { ctx: onlineAnon, pickedBy: "online-anon" };
  // 4. 磁盘扫描（会话可能已被 GC，ensureSession 会重建并重载罐）：
  //    第一轮优先找登录罐；一个都没有时再用匿名登录罐
  let diskAnon = null;
  for (const sid of diskSessionIds()) {
    try {
      const raw = readFileSync(join(paths.users, sid, "cookies.json"), "utf8");
      const hasU = raw.includes("MUSIC_U");
      const hasA = !hasU && raw.includes("MUSIC_A");
      if (!hasU && !hasA) continue;
      const ctx = await ensureSession(sid);
      if (hasU && isLoggedIn(ctx.cookies())) return { ctx, pickedBy: "disk" };
      if (hasA && !diskAnon) diskAnon = ctx;
    } catch {
      /* 该目录没有可读罐，跳过 */
    }
  }
  if (diskAnon) return { ctx: diskAnon, pickedBy: "disk-anon" };
  // 5. 兜底：匿名（shared）—— 空罐，只有新注册的设备号，搜索可能被风控
  return { ctx: await ensureSession("shared"), pickedBy: "anonymous" };
}

/* ────────────────────────── 下载目录 ────────────────────────── */

let cachedRoot = null;
async function downloadRoot() {
  if (cachedRoot) return cachedRoot;
  const want = resolveDownloadDir();
  try {
    await mkdir(want, { recursive: true });
    cachedRoot = want;
  } catch (e) {
    const fallback = join(paths.dataDir, "downloads");
    log.warn(`下载目录 ${want} 不可用（${e.message}），退回 ${fallback}`);
    await mkdir(fallback, { recursive: true }).catch(() => {});
    cachedRoot = fallback;
  }
  return cachedRoot;
}

/* ────────────────────────── 下载任务表 ────────────────────────── */

/** id → task；完成后保留在表里（history），超过 HISTORY_LIMIT 淘汰最旧的已完成项 */
const agentTasks = new Map();

function taskView(t) {
  const percent = t.total ? Math.min(100, Math.round((t.down / t.total) * 100)) : 0;
  return {
    id: t.id,
    songId: t.songId,
    name: t.name,
    artists: t.artists,
    album: t.album,
    br: t.br,
    state: t.state, // running | done | failed | cancelled
    progress: { down: t.down, total: t.total, speed: Math.round(t.speed), percent },
    relativePath: t.relativePath,
    path: t.path,
    error: t.error || undefined,
    freeTrial: t.freeTrial || false,
    freeTrialMs: t.freeTrialMs || 0,
    loggedOutSource: t.loggedOutSource || false,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt || undefined,
  };
}

function pruneHistory() {
  const done = [...agentTasks.values()]
    .filter((t) => t.state !== "running")
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  while (done.length > HISTORY_LIMIT) {
    const oldest = done.shift();
    agentTasks.delete(oldest.id);
  }
}

function runningCount() {
  let n = 0;
  for (const t of agentTasks.values()) if (t.state === "running") n++;
  return n;
}

/** 启动一首歌的下载（含取直链 → 命名 → 落盘），resolve 后任务仍在表里跑 */
async function startSongDownload(ctx, { song, br }) {
  if (runningCount() >= MAX_CONCURRENT) {
    const err = new Error(`并发任务已达上限 ${MAX_CONCURRENT}，稍后再试或先取消`);
    err.code = 429;
    throw err;
  }

  // 1. 只有 songId 时补全歌名/歌手
  let meta = song;
  if (!meta || !meta.name) {
    meta = await getSongDetail({ cookieJar: ctx.cookies(), id: song.id });
    if (!meta) {
      const err = new Error(`查不到歌曲详情（songId=${song.id}）`);
      err.code = 404;
      throw err;
    }
  }

  // 2. 取直链
  const su = await getSongUrl({ cookieJar: ctx.cookies(), id: meta.id, br });
  if (!su.url) {
    const err = new Error(
      isLoggedIn(ctx.cookies())
        ? "拿不到音源 URL（歌曲无版权或账号权限不足）"
        : "拿不到音源 URL：当前会话未登录网易账号，先在浏览器里扫码登录再试"
    );
    err.code = 409;
    err.loggedIn = isLoggedIn(ctx.cookies());
    throw err;
  }

  // 3. 命名与目录
  const root = await downloadRoot();
  const ext = su.type === "flac" ? "flac" : su.type === "ape" ? "ape" : su.type || "mp3";
  const artistPart = safeName((meta.artists || []).join(", ")) || "未知歌手";
  let rel = `${artistPart} - ${safeName(meta.name)}.${ext}`;
  let target;
  try {
    target = safeJoin(root, rel);
  } catch (e) {
    const err = new Error(`非法文件名: ${rel}`);
    err.code = 400;
    throw err;
  }
  // 重名顺延，绝不覆盖已有歌
  let n = 1;
  while (existsSync(target)) {
    rel = `${artistPart} - ${safeName(meta.name)} (${n++}).${ext}`;
    target = safeJoin(root, rel);
  }

  // 4. 登记 + 跑
  const id = `agent-${Date.now().toString(36)}-${randomId(3)}`;
  const ctrl = new AbortController();
  const task = {
    id,
    songId: meta.id,
    name: meta.name,
    artists: meta.artists || [],
    album: meta.album || "",
    br: su.br || br,
    state: "running",
    down: 0,
    total: su.size || 0,
    speed: 0,
    relativePath: rel,
    path: target,
    freeTrial: su.freeTrial,
    freeTrialMs: su.freeTrialMs,
    loggedOutSource: !isLoggedIn(ctx.cookies()),
    startedAt: Date.now(),
    ctrl,
  };
  agentTasks.set(id, task);

  (async () => {
    try {
      const { size } = await downloadToFile({
        url: su.url,
        destPath: target,
        signal: ctrl.signal,
        onProgress: ({ down, total: total2, speed }) => {
          task.down = down;
          if (total2) task.total = total2;
          task.speed = speed;
        },
      });
      task.state = "done";
      task.down = size;
      if (!task.total) task.total = size;
      task.finishedAt = Date.now();
      log.info(`[agent] 下载完成 ${task.name} → ${task.path}（${(size / 1048576).toFixed(2)} MB）`);
    } catch (e) {
      if (/abort/i.test(String(e.message))) {
        task.state = "cancelled";
        task.error = "已取消";
      } else {
        task.state = "failed";
        task.error = e.message;
      }
      task.finishedAt = Date.now();
      log.warn(`[agent] 下载任务 ${id} 终态 ${task.state}: ${e.message}`);
    } finally {
      pruneHistory();
    }
  })();

  return task;
}

/* ────────────────────────── 路由 ────────────────────────── */

export function mountAgent() {
  const token = loadOrCreateToken();
  const auth = makeAuth(token);
  const r = Router();

  // POST body 解析。⚠️ 只能挂在 /agent 这个 Router 上、不能挂到全局 app：
  // 全局 json parser 会把 Content-Type: application/json 的请求体消费掉，
  // 反代层的流转发（官方 eapi POST）就再也读不到 body 了。
  r.use(express.json({ limit: "1mb" }));
  // body 解析失败 → 干净的 400（默认 handler 会往 stderr 打一大段 SyntaxError 栈）
  r.use((err, _req, res, next) => {
    if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) {
      res.status(400).json({ code: 400, error: "bad_json", message: "请求体不是合法 JSON" });
      return;
    }
    next(err);
  });

  // 免鉴权存活探测：给 skill 判断"地址通不通、要不要 token"
  r.get("/ping", (_req, res) => {
    res.json({ ok: true, agent: true, version: VERSION, authRequired: true });
  });

  r.use(auth);

  r.get("/status", async (req, res) => {
    try {
      const { ctx, pickedBy } = await resolveAgentSession(req);
      const loggedIn = isLoggedIn(ctx.cookies());
      let downloadDir = "";
      try {
        downloadDir = await downloadRoot();
      } catch {
        downloadDir = resolveDownloadDir();
      }
      res.json({
        ok: true,
        agent: true,
        version: VERSION,
        uptimeSec: Math.round(process.uptime()),
        multiUser: config.multiUser,
        sessionId: ctx.sid,
        sessionPickedBy: pickedBy,
        loggedIn,
        downloadDir,
        tasks: { running: runningCount(), known: agentTasks.size },
      });
    } catch (e) {
      res.status(500).json({ code: 500, error: "status_failed", message: e.message });
    }
  });

  r.get("/search", async (req, res) => {
    const keyword = String(req.query.keyword || "").trim();
    if (!keyword) {
      res.status(400).json({ code: 400, error: "bad_request", message: "缺少 ?keyword=" });
      return;
    }
    try {
      const { ctx } = await resolveAgentSession(req);
      const out = await searchSongs({
        cookieJar: ctx.cookies(),
        keyword,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(502).json({ code: 502, error: "search_failed", message: e.message });
    }
  });

  r.post("/download", async (req, res) => {
    const b = req.body || {};
    const songId = Number(b.songId ?? b.id);
    if (!Number.isFinite(songId) || songId <= 0) {
      res.status(400).json({ code: 400, error: "bad_request", message: "缺少 songId" });
      return;
    }
    const song = {
      id: songId,
      name: typeof b.name === "string" ? b.name : undefined,
      artists: Array.isArray(b.artists) ? b.artists.map(String) : undefined,
      album: typeof b.album === "string" ? b.album : undefined,
    };
    try {
      const { ctx, pickedBy } = await resolveAgentSession(req);
      const task = await startSongDownload(ctx, {
        song,
        br: Number(b.br) || 320000,
      });
      res.json({
        ok: true,
        taskId: task.id,
        state: task.state,
        relativePath: task.relativePath,
        freeTrial: task.freeTrial,
        loggedOutSource: task.loggedOutSource,
        sessionPickedBy: pickedBy,
        note: task.freeTrial
          ? "该歌曲当前只会下载试听片段（未登录或非 VIP），登录后重试可获得完整音源"
          : undefined,
        progressUrl: `/agent/download/${task.id}`,
      });
    } catch (e) {
      const code = e.code && Number.isInteger(e.code) ? e.code : 500;
      res.status(code >= 400 && code < 600 ? code : 500).json({
        code,
        error: code === 429 ? "too_many_tasks" : "download_failed",
        message: e.message,
      });
    }
  });

  r.get("/download/tasks", (_req, res) => {
    const list = [...agentTasks.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    res.json({
      ok: true,
      running: runningCount(),
      tasks: list.map(taskView),
    });
  });

  r.get("/download/:id", (req, res) => {
    const t = agentTasks.get(String(req.params.id));
    if (!t) {
      res.status(404).json({ code: 404, error: "not_found", message: "没有这个任务（可能已完成太久被清理）" });
      return;
    }
    res.json({ ok: true, task: taskView(t) });
  });

  r.delete("/download/:id", async (req, res) => {
    const t = agentTasks.get(String(req.params.id));
    if (!t) {
      res.status(404).json({ code: 404, error: "not_found", message: "没有这个任务" });
      return;
    }
    if (t.state === "running") {
      t.ctrl?.abort?.();
      // 引擎会在 abort 后把状态置为 cancelled；这里立即反映意图
      t.state = "cancelled";
      t.error = "已取消";
      t.finishedAt = Date.now();
    }
    res.json({ ok: true, task: taskView(t) });
  });

  log.info(
    `Agent API 已挂载 /agent/*（token: ${join(paths.dataDir, "agent-token")}` +
      `${process.env.NASNEM_AGENT_TOKEN ? "，来自环境变量" : ""}）`
  );
  return r;
}

export default mountAgent;
