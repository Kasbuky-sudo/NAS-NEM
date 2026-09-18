/**
 * 桥接层 WebSocket 服务端
 * ========================
 * 顶替 CEF 注入的 `window.channel`。协议见 web/shim.js 顶部注释。
 *
 * 每个浏览器会话一份独立上下文（数据目录 / cookie 罐 / SQLite / 分发器），
 * 这样同一台 NAS 上多人用不会互相串号，也方便单用户场景关掉多用户模式。
 */
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";

import config, { paths } from "../config.js";
import createLogger from "../logger.js";
import { randomId } from "../util.js";
import CallDispatcher from "./dispatcher.js";
import SessionCookies from "./cookiejar.js";
import buildRegistry from "./calls/index.js";

const log = createLogger("bridge");

/** sid → session */
const sessions = new Map();

/* ------------------------------------------------------------------ *
 * 调用抓包（调试用）
 * NASNEM_TRACE=<路径> 时，把前端发来的每条 call 的 cmd / 参数 /
 * 返回值 / 耗时 / 异常写进 JSONL。用来定位前端启动期崩溃到底是
 * 哪条命令的返回形状不对。
 * ------------------------------------------------------------------ */
const TRACE_FILE = process.env.NASNEM_TRACE || "";
if (TRACE_FILE) {
  try {
    writeFileSync(TRACE_FILE, "");
    log.info(`调用抓包已开启 → ${TRACE_FILE}`);
  } catch (e) {
    log.warn(`抓包文件无法写入: ${e.message}`);
  }
}

/** 把任意值裁成一个可读、有限长度的摘要，避免日志爆掉 */
function clip(v, depth = 0) {
  if (v === undefined) return "«undefined»";
  if (v === null) return null;
  if (typeof v === "function") return "«function»";
  if (typeof v === "string") return v.length > 400 ? v.slice(0, 400) + `…(+${v.length - 400})` : v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (depth >= 3) return Array.isArray(v) ? `«Array(${v.length})»` : "«Object»";
  if (Array.isArray(v)) return v.slice(0, 8).map((x) => clip(x, depth + 1));
  if (typeof v === "object") {
    const o = {};
    let n = 0;
    for (const k of Object.keys(v)) {
      if (n++ >= 12) {
        o["…"] = `+${Object.keys(v).length - 12}`;
        break;
      }
      o[k] = clip(v[k], depth + 1);
    }
    return o;
  }
  return String(v);
}

function trace(rec) {
  if (!TRACE_FILE) return;
  try {
    appendFileSync(TRACE_FILE, JSON.stringify(rec) + "\n");
  } catch {
    /* ignore */
  }
}

export function sessionCount() {
  return sessions.size;
}

async function createSession(sid) {
  const base = config.multiUser ? join(paths.users, sid) : join(paths.users, "shared");
  mkdirSync(base, { recursive: true });
  for (const sub of ["cache", "temp", "storage"]) mkdirSync(join(base, sub), { recursive: true });

  const cookies = new SessionCookies(base);
  const ctx = {
    sid,
    dataDir: base,
    startTime: Date.now(),
    origin: "http://localhost",
    sockets: new Set(),
    /** 推事件给这个会话的所有连接 */
    emit(name, args) {
      const payload = JSON.stringify({ type: "event", name, args: args || [] });
      for (const ws of ctx.sockets) {
        if (ws.readyState === 1) ws.send(payload);
      }
    },
    cookies: () => cookies,
    saveCookies: () => cookies.save(),
  };

  const { handlers, fallback, stats } = await buildRegistry(ctx);
  ctx.stats = stats;

  const dispatcher = new CallDispatcher();
  // 先注册兜底，再注册真实实现（后者覆盖前者）
  for (const key of Object.keys(handlers)) dispatcher.registerHandler(key, handlers[key]);
  ctx.dispatcher = dispatcher;
  ctx.fallback = fallback;

  ctx.dispatch = async (cmd, callback, args) => {
    const hit = dispatcher.has(cmd);
    if (!hit) {
      const fn = fallback(cmd);
      const res = await fn(...args);
      callback(...(Array.isArray(res) ? res : []));
      return;
    }
    await dispatcher.dispatch(cmd, callback, ...args);
  };

  sessions.set(sid, ctx);
  log.info(`会话建立 ${sid} → ${base}`);
  return ctx;
}

/** 从 Cookie 头里取 sid */
function sidFrom(req) {
  const raw = req.headers.cookie || "";
  const m = /(?:^|;\s*)nas_sid=([^;]+)/.exec(raw);
  return m ? decodeURIComponent(m[1]) : null;
}

export function getSession(sid) {
  return sessions.get(sid);
}

/**
 * 挂到 http server 上。
 * @param {import("node:http").Server} server
 */
export function attachBridge(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url, "http://x").pathname;
    } catch {
      /* ignore */
    }
    if (pathname !== "/__bridge") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", async (ws, req) => {
    let sid = sidFrom(req);
    if (!sid || !/^[A-Za-z0-9_-]{4,64}$/.test(sid)) sid = randomId(12);

    let ctx = sessions.get(sid);
    if (!ctx) {
      try {
        ctx = await createSession(sid);
      } catch (e) {
        log.error(`创建会话失败: ${e.message}`);
        ws.close();
        return;
      }
    }
    ctx.sockets.add(ws);
    ctx.origin = `http://${req.headers.host || "localhost"}`;

    ws.send(JSON.stringify({ type: "hello", sid, server: "nas-nem" }));

    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "listen") {
        // 目前只需知道前端注册了哪些事件；真正推送由业务侧触发
        return;
      }
      if (msg.type !== "call") return;

      const id = msg.id;
      const cmd = String(msg.cmd || "");
      const args = Array.isArray(msg.args) ? msg.args : [];
      let replied = false;
      const t0 = Date.now();

      if (TRACE_FILE) trace({ t: t0, sid, dir: "→", cmd, args: clip(args) });

      const callback = (...out) => {
        if (replied) return; // 只会话内回传一次（官方也是单次回调）
        replied = true;
        if (TRACE_FILE) trace({ t: Date.now(), sid, dir: "←", cmd, ms: Date.now() - t0, ret: clip(out) });
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "result", id, data: out }));
        }
      };

      try {
        await ctx.dispatch(cmd, callback, args);
        if (!replied && TRACE_FILE) {
          trace({ t: Date.now(), sid, dir: "⚠", cmd, ms: Date.now() - t0, note: "回调未触发（命令挂起）" });
        }
      } catch (e) {
        log.warn(`命令 ${cmd} 执行异常: ${e.message}`);
        if (TRACE_FILE) trace({ t: Date.now(), sid, dir: "✖", cmd, ms: Date.now() - t0, error: e.message, stack: (e.stack || "").split("\n").slice(0, 4) });
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "error", id, message: e.message }));
        }
      }
    });

    ws.on("close", () => {
      ctx.sockets.delete(ws);
      ctx.saveCookies();
      // 会话对象常驻（cookie / 数据要留着），5 分钟后回收内存
      clearTimeout(ctx.gc);
      ctx.gc = setTimeout(() => {
        if (ctx.sockets.size === 0) sessions.delete(ctx.sid);
      }, 5 * 60_000);
    });

    log.debug(`WS 连接 ${sid}（该会话连接数 ${ctx.sockets.size}）`);
  });

  log.info("桥接层已挂载: ws(s)://<host>/__bridge");
  return wss;
}

/** 保证会话存在（HTTP 侧要用，比如反代里存 cookie） */
export async function ensureSession(sid) {
  let ctx = sessions.get(sid);
  if (!ctx) ctx = await createSession(sid);
  return ctx;
}

export default attachBridge;
