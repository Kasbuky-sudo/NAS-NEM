/**
 * 命令注册总表
 * ==============
 * 把各命名空间的实现拼成一张 `cmd → handler` 表，交给 CallDispatcher。
 *
 * 另外挂一个**兜底 handler**：官方前端一共有 170+ 条宿主命令，Web 版不可能一次全实现。
 * 与其让未实现的命令把前端的 Promise 挂死（官方 `Bridge.call` 不回调就永不 resolve），
 * 不如统一返回空结果并记一条 warning，让启动流程继续往下走 —— 然后我们按日志补实现。
 */
import createLogger from "../../logger.js";

import makeAppCalls from "./app.js";
import makeOsCalls from "./os.js";
import makeStorageCalls from "./storage.js";
import makeNetworkCalls from "./network.js";
import makeBrowserCalls from "./browser.js";
import makeCryptoCalls from "./crypto.js";
import makeDownloadCalls from "./download.js";

const log = createLogger("calls");

/** 这些命令调用极其频繁且无副作用，日志里过滤掉，免得刷屏 */
const QUIET = /^(app\.(log|statis|statisV2|perfReport|sendStatis)|player\.(setInfo|setLyrics|setCover|setOffset|updateTooltips)|storage\.(savetofile|readfromfile)|__enc\.)/;

/** 只上报前 N 次同一个未实现命令，避免刷屏 */
const MISSING_LIMIT = 3;

export async function buildRegistry(ctx) {
  const handlers = Object.assign(
    Object.create(null),
    makeAppCalls(ctx),
    makeOsCalls(ctx),
    makeNetworkCalls(ctx),
    makeBrowserCalls(ctx),
    makeCryptoCalls(ctx),
    makeDownloadCalls(ctx),
    await makeStorageCalls(ctx)
  );

  const missing = new Map();

  /** 兜底：未实现的命令 */
  const fallback = (cmd) => (...args) => {
    const n = (missing.get(cmd) || 0) + 1;
    missing.set(cmd, n);
    if (n <= MISSING_LIMIT && !QUIET.test(cmd)) {
      const preview = args.map((a) => (typeof a === "string" ? a.slice(0, 60) : typeof a)).join(", ");
      log.warn(`未实现命令 ${cmd}(${preview}) —— 返回空结果，第 ${n} 次`);
    }
    return [];
  };

  return {
    handlers,
    fallback,
    stats: () => Object.fromEntries([...missing.entries()].sort((a, b) => b[1] - a[1])),
  };
}

export default buildRegistry;
