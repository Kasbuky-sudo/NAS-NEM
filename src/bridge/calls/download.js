/**
 * download.* —— 原生下载管理器的服务端实现
 * ==========================================
 * 官方 CEF 客户端把"下载歌曲/音效/封面"交给原生下载管理器，前端只发命令：
 *
 *     download.start(task)        task = {id, md5, md5_check_fail, mediaType,
 *                                        pre_path, rel_path, size, url, ext_header, type?}
 *                                 （前端 SDK 侧字段是驼峰 prePath/relativePath，发了双层）
 *     download.pause(...)         暂停（Web 版实现为中止，重新 start 即续传逻辑）
 *     download.cancel(...)        取消并删除半成品
 *     download.queryDownloadShecdule()   （官方拼写错误，照抄）
 *
 * 进度/结果通过**事件**回推（appendRegisterCall 注册名 → `download.on<注册名>`）：
 *     "process"           → download.onprocess(id, {down, islast, path, relative, speed, total, type})
 *     "downloadeshecdule" → download.ondownloadeshecdule([{id, shecdule}, …])
 *
 * 落地目录：config.resolveDownloadDir() —— NAS 上默认 /vol1/1000/网易云音乐，
 * 由 storage.init 回传给前端当 `Setting.downloadDir`，前端拼出 prePath 再传回来。
 * 安全：所有落盘路径必须落在该目录内（safeJoin 越界即抛），半成品写 ".part" 成功后改名。
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import createLogger from "../../logger.js";
import { resolveDownloadDir } from "../../config.js";
import { safeJoin } from "../../util.js";

const log = createLogger("call:download");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Netease_Music PC 3.1.34.205281";

/** 活跃任务表：id → entry */
const tasks = new Map();

/** 前端 SDK 可能把对象 JSON 成字符串再发过来，两种形态都接 */
function parseArg(v) {
  if (v && typeof v === "object") return v;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }
  return {};
}

function emitProcess(ctx, entry, isLast) {
  ctx.emit("download.onprocess", [
    entry.id,
    {
      down: entry.down,
      islast: isLast ? 1 : 0,
      path: entry.path,
      relative: entry.relativePath,
      relativePath: entry.relativePath,
      speed: Math.max(0, Math.round(entry.speed)),
      total: entry.total,
      type: entry.type,
    },
  ]);
}

/** 拉流落盘：写 .part，完成后改名；每 400ms 推一次进度，结束推 islast */
async function runDownload(ctx, entry) {
  const partFile = `${entry.path}.part`;
  try {
    const res = await fetch(entry.url, {
      signal: entry.ctrl.signal,
      headers: { "User-Agent": UA },
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const len = Number(res.headers.get("content-length")) || 0;
    if (len) entry.total = len;

    let lastTick = Date.now();
    let lastDown = 0;
    const ws = createWriteStream(partFile);

    for await (const chunk of res.body) {
      if (entry.cancelled) break;
      entry.down += chunk.length;
      if (!ws.write(chunk)) {
        await new Promise((r) => ws.once("drain", r));
      }
      const now = Date.now();
      if (now - lastTick >= 400) {
        entry.speed = ((entry.down - lastDown) * 1000) / Math.max(1, now - lastTick);
        lastTick = now;
        lastDown = entry.down;
        emitProcess(ctx, entry, false);
      }
    }

    await new Promise((r) => ws.end(r));
    if (entry.cancelled) {
      await rm(partFile, { force: true });
      log.info(`任务 ${entry.id} 已取消/暂停`);
    } else {
      entry.speed = 0;
      await rename(partFile, entry.path);
      const st = await stat(entry.path);
      if (!entry.total) entry.total = st.size;
      log.info(`任务 ${entry.id} 完成 → ${entry.path}（${(st.size / 1048576).toFixed(2)} MB）`);
      emitProcess(ctx, entry, true);
    }
  } catch (e) {
    if (entry.cancelled || /abort/i.test(String(e.message))) {
      await rm(partFile, { force: true }).catch(() => {});
      log.info(`任务 ${entry.id} 中止: ${e.message}`);
    } else {
      log.warn(`任务 ${entry.id} 失败: ${e.message} ← ${String(entry.url).slice(0, 120)}`);
      await rm(partFile, { force: true }).catch(() => {});
      // 失败也要给终态事件，别让 UI 永远转圈
      entry.down = 0;
      entry.speed = 0;
      emitProcess(ctx, entry, true);
    }
  } finally {
    tasks.delete(entry.id);
  }
}

function makeDownloadCalls(ctx) {
  /** 下载根目录（懒解析 + 可写性兜底） */
  let cachedRoot = null;
  async function root() {
    if (cachedRoot) return cachedRoot;
    const want = resolveDownloadDir();
    try {
      await mkdir(want, { recursive: true });
      cachedRoot = want;
    } catch (e) {
      const fallback = join(ctx.dataDir || ".", "downloads");
      log.warn(`下载目录 ${want} 不可用（${e.message}），退回 ${fallback}`);
      await mkdir(fallback, { recursive: true }).catch(() => {});
      cachedRoot = fallback;
    }
    return cachedRoot;
  }

  return {
    /**
     * download.start(task) —— task 字段兼容驼峰/下划线两种
     * 事件：download.onprocess(id, {down, islast, path, relative, speed, total, type})
     */
    "download.start": async (task) => {
      const t = parseArg(task);
      const id = String(t.id ?? `dl-${Date.now()}`);
      const url = String(t.url ?? "");
      const relPath = String(t.rel_path ?? t.relativePath ?? "")
        .replace(/\\/g, "/")
        .replace(/^\/+/, "");
      const prePath = String(t.pre_path ?? t.prePath ?? "");
      const type = t.type ?? t.mediaType ?? 0;

      if (!url || !relPath) {
        log.warn(`download.start 缺参数 url/rel_path: ${JSON.stringify(t).slice(0, 200)}`);
        return [];
      }

      // 旧任务还在跑就先停掉（前端会拿同一个 id 重新 start）
      const old = tasks.get(id);
      if (old) {
        old.cancelled = true;
        old.ctrl.abort();
        tasks.delete(id);
      }

      // prePath 只认下载根目录自己（或为空），外来绝对路径一律折回根目录
      const r = await root();
      const base =
        prePath && prePath.replace(/\\/g, "/").startsWith(r) ? prePath : r;
      let target;
      try {
        target = safeJoin(base, relPath);
      } catch (e) {
        log.warn(`download.start 路径越界: ${relPath}`);
        return [];
      }
      await mkdir(dirname(target), { recursive: true });

      const entry = {
        id,
        url,
        type,
        path: target,
        relativePath: relPath,
        total: Number(t.size) || 0,
        down: 0,
        speed: 0,
        cancelled: false,
        ctrl: new AbortController(),
      };
      tasks.set(id, entry);
      emitProcess(ctx, entry, false);
      runDownload(ctx, entry); // 故意不 await：命令立即回，进度走事件
      return [];
    },

    /** 暂停 = 中止本次拉流（半成品丢弃，重下走 start） */
    "download.pause": async (task) => {
      const t = parseArg(task);
      const id = String(t.id ?? task ?? "");
      const entry = tasks.get(id);
      if (entry) {
        entry.cancelled = true;
        entry.ctrl.abort();
      }
      return [];
    },

    /** 取消 = 中止 + 删半成品 */
    "download.cancel": async (task) => {
      const t = parseArg(task);
      const id = String(t.id ?? task ?? "");
      const entry = tasks.get(id);
      if (entry) {
        entry.cancelled = true;
        entry.ctrl.abort();
        await rm(`${entry.path}.part`, { force: true }).catch(() => {});
      }
      return [];
    },

    /** 查询进度 → 事件 download.ondownloadeshecdule([{id, shecdule}]) */
    "download.queryDownloadShecdule": async () => {
      const list = [];
      for (const entry of tasks.values()) {
        const shecdule = entry.total
          ? Math.min(100, Math.round((entry.down / entry.total) * 100))
          : 0;
        list.push({
          id: entry.id,
          shecdule,
          down: entry.down,
          total: entry.total,
          path: entry.path,
          speed: Math.round(entry.speed),
          state: "start",
        });
      }
      ctx.emit("download.ondownloadeshecdule", [list]);
      return [];
    },
  };
}

export default makeDownloadCalls;
