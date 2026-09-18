/**
 * 极简分级日志。Docker 场景直接输出到 stdout。
 */
import config from "./config.js";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function emit(level, tag, args) {
  if (LEVELS[level] > threshold) return;
  const line = `[${ts()}] ${level.toUpperCase().padEnd(5)} ${tag ? `(${tag}) ` : ""}`;
  const stream = level === "error" ? console.error : console.log;
  stream(line + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
}

export function createLogger(tag = "") {
  return {
    error: (...a) => emit("error", tag, a),
    warn: (...a) => emit("warn", tag, a),
    info: (...a) => emit("info", tag, a),
    debug: (...a) => emit("debug", tag, a),
  };
}

/**
 * 默认导出就是 `createLogger` 本身（而不是 logger 实例）。
 * 全项目统一写法 `import createLogger from "…/logger.js"`，少一个记名字的负担。
 */
export default createLogger;

/** 顺带提供一个免 tag 的实例 */
export const log = createLogger();
