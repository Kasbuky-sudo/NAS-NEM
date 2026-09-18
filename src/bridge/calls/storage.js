/**
 * storage.* —— 本地数据库 + 文件
 * ================================
 * 这是启动链路里最关键的一环：官方前端用 `storage.execsql` 建自己的本地表
 * （曲库、缓存索引、播放记录…）。
 *
 * 官方协议有**两种**回传方式，混了就一定白屏，这里逐个对齐（全部从 bundle 里核过）：
 *
 * ① 直接回调型（`At.call(cmd, …params, cb)`，cb 被 SDK 摘走）
 *      storage.init(path, capacity, cachePath)      → cb({ path, cachePath })
 *      storage.testwriteable(path)                  → cb(ok)
 *      storage.getSystemDir({type:108})             → 直接 return 路径
 *      storage.playCacheInfo()                      → 直接 return
 *
 * ② 事件推送型（命令本身不返回结果，结果经 `<ns>.on<event>` 推回）
 *      命令                                         事件 / 载荷
 *      storage.execsql(taskId, sqlText)             storage.onexecsqldone(taskId, errorCode, rows)
 *      storage.exectransaction(…同…)                同上
 *      storage.savetofile(taskId, content, mode, p, alone, abs)   storage.onsavetofiledone(taskId, errorCode)
 *      storage.readfromfile(taskId, p, alone, abs)  storage.onreadfromfiledone(taskId, errorCode, content)
 *      storage.deletefile(taskId, abs, "", p, rec)  storage.ondeletefilesdone(taskId, errorCode, path)
 *      storage.listFile(taskId, abs, "", filter)    storage.onlistfile(taskId, errorCode, entries)
 *      storage.clearCache(p)                        storage.onclearcache(ok)
 *      storage.getTempFile(url)                     storage.ongettempfile(url, code, lyricJson)
 *      storage.checkFilesExist(taskId, files, dir)  storage.oncheckfilesexist(taskId, ok, flags)
 *      storage.imagesInfo(taskId, task)             storage.onimagesinfo(taskId, results)
 *      storage.queryCacheTracks()                   storage.onquerycachetracks(tracks)
 *      storage.setPlayCacheConfig(cfg)              storage.onsetplaycacheconfig(ok)
 *      musiclibrary.execSql(taskId, sqlArray)       musiclibrary.onexecsql({id, error, value})
 *
 * ⚠️ 事件名是 `命名空间 + ".on" + 注册名`，注册名首字母**不大写**：
 *    `appendRegisterCall("savetofiledone","storage",…)` → `storage.onsavetofiledone`
 *    只有 `overwriteRegisterCall("GetDeviceInfo","os",…)` 这种才带大写。
 *
 * ⚠️ ②类命令**必须**推事件：官方 SDK 在 `At.call` 之后 `finally` 摘掉监听，
 *    客户端等的是自己的 Promise，我们只 `return []` 的话前端会**永久 pending**。
 *
 * SQL 说明：sqlText 是**多条语句拼在一起的字符串**（前端 `i.join("")`）。
 * Web 版直接用 Node 22 内置的 `node:sqlite`（无需编译原生模块 → 多架构镜像友好）。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import createLogger from "../../logger.js";
import { clientPath, safeJoin } from "../../util.js";
import { resolveDownloadDir } from "../../config.js";

const log = createLogger("call:storage");

/** 延迟加载 node:sqlite —— 老版 Node 上没有这个模块，要能优雅降级 */
let sqliteMod = null;
let sqliteTried = false;
async function getSqlite() {
  if (sqliteTried) return sqliteMod;
  sqliteTried = true;
  try {
    sqliteMod = await import("node:sqlite");
    log.info("使用 node:sqlite 作为本地库");
  } catch (e) {
    log.warn(`node:sqlite 不可用（${e.message}），storage.execsql 将返回空结果`);
    sqliteMod = null;
  }
  return sqliteMod;
}

export async function makeStorageCalls(ctx) {
  const sqlite = await getSqlite();
  const dir = ctx.dataDir;
  let db = null;

  function open() {
    if (db || !sqlite) return db;
    const file = join(dir, "library.db");
    try {
      db = new sqlite.DatabaseSync(file);
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA foreign_keys = ON;");
      log.info(`本地库已打开: ${file}`);
    } catch (e) {
      log.warn(`打开本地库失败: ${e.message}`);
      db = null;
    }
    return db;
  }

  /** 按分号切语句，跳过引号/注释里的分号 */
  function splitStatements(sql) {
    const out = [];
    let buf = "";
    let quote = null; // ' " `
    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];
      if (quote) {
        buf += ch;
        if (ch === quote) {
          if (sql[i + 1] === quote) {
            buf += sql[++i]; // 转义引号
          } else {
            quote = null;
          }
        }
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
        buf += ch;
        continue;
      }
      if (ch === "-" && sql[i + 1] === "-") {
        const nl = sql.indexOf("\n", i);
        i = nl < 0 ? sql.length : nl;
        continue;
      }
      if (ch === ";") {
        const t = buf.trim();
        if (t) out.push(t);
        buf = "";
        continue;
      }
      buf += ch;
    }
    const tail = buf.trim();
    if (tail) out.push(tail);
    return out;
  }

  /**
   * 执行一串 SQL。
   * 前端约定：`storage.execsql(taskId, sqlText)` 里的 sqlText 是多条语句**拼在一起**的
   * （`i.join("")`，每条自带分号）。SELECT/PRAGMA 返回行，其余语句返回空数组。
   */
  function runSql(sqlText) {
    const d = open();
    if (!d) return { error: 1, rows: [] };

    const text = Array.isArray(sqlText) ? sqlText.join("") : String(sqlText ?? "");
    const trimmed = text.trim();
    if (!trimmed) return { error: 0, rows: [] };

    const statements = splitStatements(trimmed);
    let rows = [];
    try {
      for (const stmt of statements) {
        if (/^\s*(select|pragma|with)\b/i.test(stmt)) {
          rows = d.prepare(stmt).all();
        } else {
          d.exec(stmt);
        }
      }
      return { error: 0, rows };
    } catch (e) {
      log.warn(`SQL 失败: ${e.message} ← ${trimmed.slice(0, 160)}`);
      return { error: 1, rows: [] };
    }
  }

  const abs = (p, mode) => clientPath(dir, p, mode);

  /** `storage.getSystemDir({type:108})` 的返回：给一个真实存在、可写的目录 */
  const SYSTEM_DIR = join(dir, "files");
  await mkdir(SYSTEM_DIR, { recursive: true }).catch(() => {});
  await mkdir(join(dir, "cache"), { recursive: true }).catch(() => {});
  await mkdir(join(dir, "temp"), { recursive: true }).catch(() => {});

  return {
    /* ─────────── 数据库 ─────────── */

    /**
     * ① 直接回调型，**必须回两个参数**：
     *
     *     At.call("storage.init", e.path, e.capacity.toString(), e.cachePath, t)
     *     t = (path, cachePath) => resolve({ path, cachePath })
     *
     * SDK 的 `Storage.downloadDir` / `cacheDir` 就靠这个赋值。
     * 曾经这里 return 了一个 `{path, cachePath}` 对象（只占一个回调位），
     * 结果 `path` 收到整个对象、`cachePath` 收到 undefined，
     * `Storage.downloadDir` 变成一个对象 → `Setting.get().downloadDir` 也是对象
     * → 下游 `n.replace(/\\$/,"")` 报 "n.replace is not a function"
     * → 连环把 `addScanTask` 里的 `i.charAt` 也带崩。
     * 一个返回值形状错误，能顺着数据流炸出一串互不相干的异常。
     */
    "storage.init": (p, capacity, cachePath) => {
      open();
      // 下载目录优先给"真实落地目录"（NAS 上是 /vol1/1000/网易云音乐）：
      // 前端把它存进 Setting.downloadDir，点下载时拼成 prePath 传回 download.start。
      let download;
      try {
        download = resolveDownloadDir();
      } catch {
        download = "";
      }
      download = download || String(p || "") || SYSTEM_DIR;
      const cache = String(cachePath || "") || join(dir, "cache");
      return [download, cache];
    },

    /** ② 事件推送：(taskId, errorCode, rows) */
    "storage.execsql": (taskId, sqlText) => {
      const { error, rows } = runSql(sqlText);
      ctx.emit("storage.onexecsqldone", [taskId, error, rows]);
      return [];
    },
    "storage.exectransaction": (taskId, sqlText) => {
      const { error, rows } = runSql(sqlText);
      ctx.emit("storage.onexecsqldone", [taskId, error, rows]);
      return [];
    },

    /** 新版 SDK：musiclibrary.execSql(taskId, sqlArray) → musiclibrary.onexecsql({id, error, value}) */
    "musiclibrary.execSql": (taskId, sqlArray) => {
      const { error, rows } = runSql(sqlArray);
      ctx.emit("musiclibrary.onexecsql", [{ id: taskId, error, value: rows }]);
      return [];
    },
    "musiclibrary.addLibrary": () => [],
    "musiclibrary.observeLibrary": () => [],
    "musiclibrary.removeObserveLibrary": () => [],
    "musiclibrary.removeLibrary": () => [],
    "musiclibrary.removeLibraryItems": () => [],
    "musiclibrary.parseCueInfo": () => [],
    "musiclibrary.readMusicInfo": () => [],
    /** `(yield At.call("musiclibrary.getLibraryPath", [entry]))[0].path` → 必须给 [ [{path}] ] */
    "musiclibrary.getLibraryPath": () => [[{ path: SYSTEM_DIR, sname: "我的音乐" }]],

    /* ─────────── 文件读写（沙箱在会话目录内） ─────────── */

    "storage.getSystemDir": () => [SYSTEM_DIR],

    /** ② savetofile(taskId, content, mode, path, alone, "rel"|"abs") */
    "storage.savetofile": async (taskId, content, mode, p, alone, rel) => {
      try {
        const target = abs(p, rel);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, normalizeContent(content));
        ctx.emit("storage.onsavetofiledone", [taskId, 0]);
      } catch (e) {
        log.warn(`savetofile 失败: ${e.message}`);
        ctx.emit("storage.onsavetofiledone", [taskId, 1]);
      }
      return [];
    },

    /** ② readfromfile(taskId, path, alone, "rel"|"abs") → 事件带内容 */
    "storage.readfromfile": async (taskId, p, alone, rel) => {
      try {
        const target = abs(p, rel);
        if (!existsSync(target)) {
          // 官方语义：文件不存在 → errorCode 非 0，SDK 会 reject（调用方按"首次运行无文件"处理）
          ctx.emit("storage.onreadfromfiledone", [taskId, 1, null]);
          return [];
        }
        const buf = await readFile(target);
        ctx.emit("storage.onreadfromfiledone", [taskId, 0, buf.toString("utf8")]);
      } catch (e) {
        log.warn(`readfromfile 失败: ${e.message}`);
        ctx.emit("storage.onreadfromfiledone", [taskId, 1, null]);
      }
      return [];
    },

    /** ② deletefile(taskId, "abs"|"rel", "", path, isDeleteEmptyFolder) */
    "storage.deletefile": async (taskId, rel, _k, p, _rec) => {
      let code = 0;
      try {
        await unlink(abs(p, rel));
      } catch {
        code = 1;
      }
      ctx.emit("storage.ondeletefilesdone", [taskId, code, String(p ?? "")]);
      return [];
    },

    /** ② listFile(taskId, "abs"|"rel", "", path) → entries 形如 [{type:"file"|"dir", path}] */
    "storage.listFile": async (taskId, mode, _k, p) => {
      let entries = [];
      try {
        const root = abs(p || ".", mode);
        const items = await readdir(root, { withFileTypes: true });
        for (const e of items) {
          const full = join(root, e.name);
          let size = 0;
          let mtime = 0;
          try {
            const st = await stat(full);
            size = st.size;
            mtime = st.mtimeMs;
          } catch {
            /* ignore */
          }
          entries.push({
            type: e.isDirectory() ? "dir" : "file",
            path: mode === "abs" ? full : relative(dir, full).replace(/\\/g, "/"),
            name: e.name,
            size,
            mtime,
          });
        }
      } catch {
        entries = [];
      }
      ctx.emit("storage.onlistfile", [taskId, 0, entries]);
      return [];
    },

    /** ② clearCache(path) → 事件只带一个布尔 */
    "storage.clearCache": async (p) => {
      try {
        const target = p ? abs(p, "rel") : join(dir, "cache");
        if (existsSync(target)) await rm(target, { recursive: true, force: true });
        await mkdir(target, { recursive: true }).catch(() => {});
        ctx.emit("storage.onclearcache", [true]);
      } catch {
        ctx.emit("storage.onclearcache", [false]);
      }
      return [];
    },

    /** ② getTempFile(url) → 事件 (url, code, lyricJson)，code 0 = 成功 */
    "storage.getTempFile": (url) => {
      ctx.emit("storage.ongettempfile", [String(url ?? ""), 0, "{}"]);
      return [];
    },

    "storage.updatetemp": async (url, payload) => {
      try {
        const target = safeJoin(join(dir, "temp"), String(url ?? "tmp").replace(/[\\/:*?"<>|]/g, "_"));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, String(payload ?? ""));
      } catch {
        /* ignore */
      }
      return [];
    },

    /** ② checkFilesExist(taskId, files, path) → 事件 (taskId, ok, flags[]) */
    "storage.checkFilesExist": (taskId, files, p) => {
      const list = Array.isArray(files) ? files : [files];
      const flags = list.map((f) => {
        try {
          return existsSync(abs(join(String(p ?? ""), String(f ?? "")), "abs"));
        } catch {
          return false;
        }
      });
      ctx.emit("storage.oncheckfilesexist", [taskId, 1, flags]);
      return [];
    },

    /** ① 直接回调型：`At.call("storage.testwriteable", path, cb)` → cb(ok) */
    "storage.testwriteable": async (p) => {
      let ok = false;
      try {
        const root = abs(p || ".", "abs");
        await mkdir(root, { recursive: true });
        const probe = join(root, ".write-probe");
        await writeFile(probe, "1");
        await unlink(probe);
        ok = true;
      } catch {
        ok = false;
      }
      return [ok];
    },

    /** ② imagesInfo(taskId, task) → 事件 (taskId, results[]) */
    "storage.imagesInfo": (taskId) => {
      ctx.emit("storage.onimagesinfo", [taskId, []]);
      return [];
    },

    /** ② queryCacheTracks() → 事件只带一个数组 */
    "storage.queryCacheTracks": () => {
      ctx.emit("storage.onquerycachetracks", [[]]);
      return [];
    },
    "storage.queryNewCacheTrack": () => {
      ctx.emit("storage.onquerynewcachetracks", [[]]);
      return [];
    },
    "storage.queryNewCacheTracks": () => {
      ctx.emit("storage.onquerynewcachetracks", [[]]);
      return [];
    },

    /** ② setPlayCacheConfig(cfg) → 事件 (result) */
    "storage.setPlayCacheConfig": () => {
      ctx.emit("storage.onsetplaycacheconfig", [true]);
      return [];
    },
    /** ① 直接 return */
    "storage.playCacheInfo": () => ["{}"],
    "storage.getPlayCacheSize": () => [0],

    "storage.downloadscanner": () => [true],
    "storage.scanDirectory": () => [],

    "storage.copyfiles": async (from, to) => {
      try {
        await copyFile(abs(from, "abs"), abs(to, "abs"));
        return [true];
      } catch {
        return [false];
      }
    },
    "storage.movefiles": async (from, to) => {
      try {
        const dst = abs(to, "abs");
        await mkdir(dirname(dst), { recursive: true });
        await rename(abs(from, "abs"), dst);
        return [true];
      } catch {
        return [false];
      }
    },

    "storage.scaleImage": (taskId) => {
      ctx.emit("storage.onscaleimage", [taskId, 1]);
      return [];
    },
    "storage.addid3": (taskId) => {
      ctx.emit("storage.onaddid3done", [taskId, 1]);
      return [];
    },
    "storage.offlineTrack": () => ["[]"],
    "storage.fetch": () => [0, ""],
    "storage.uploadFile": () => [JSON.stringify({ error: 1, message: "web 版不支持原生上传" })],
  };
}

/** 前端有时传 base64 / 数组，这里统一成 Buffer/字符串 */
function normalizeContent(content) {
  if (content == null) return "";
  if (Buffer.isBuffer(content)) return content;
  if (Array.isArray(content)) return Buffer.from(content);
  if (typeof content === "object" && content.type === "Buffer" && Array.isArray(content.data)) {
    return Buffer.from(content.data);
  }
  return String(content);
}

export default makeStorageCalls;
