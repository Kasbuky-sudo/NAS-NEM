/**
 * 拉流落盘引擎
 * ============
 * 桥接层 `download.*` 与 Agent API（/agent/download）共用的核心：
 * 给一个 URL 和目标路径，流式写到 `<destPath>.part`，成功后原子改名。
 *
 * 进度通过 `onProgress({down, total, speed, done})` 回调（每 400ms 一次，
 * 结束时 `done: true`），订阅方自己决定推给谁（桥接层推 WS 事件，agent 更新任务表）。
 *
 * 取消：传入 `AbortController.signal`，abort 后半成品自动清理并抛 AbortError。
 * 失败：`.part` 一律删除，绝不留垃圾。
 */
import { createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";

/** 拉官方 CDN 音源用官方客户端 UA（部分 CDN 会校验） */
const CDN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Netease_Music PC 3.1.34.205281";

/**
 * @param {object} opts
 * @param {string} opts.url        音源地址
 * @param {string} opts.destPath   最终落盘绝对路径（实际先写 `<destPath>.part`）
 * @param {AbortSignal} [opts.signal]
 * @param {(p:{down:number,total:number,speed:number,done:boolean})=>void} [opts.onProgress]
 * @returns {Promise<{size:number}>} 实际落盘字节数
 */
export async function downloadToFile({ url, destPath, signal, onProgress }) {
  const partFile = `${destPath}.part`;
  let lastTick = Date.now();
  let lastDown = 0;
  let down = 0;
  let total = 0;

  try {
    const res = await fetch(url, {
      signal,
      headers: { "User-Agent": CDN_UA },
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    total = Number(res.headers.get("content-length")) || 0;
    const ws = createWriteStream(partFile);
    // ⚠️ 写流错误必须接到 Promise 上：磁盘满 / EACCES 时 ws 会 emit 'error'，
    // 没人接就是 unhandledRejection → 整个服务进程退出（真机实录过流错误崩进程）。
    const wsFailed = new Promise((_, reject) => ws.once("error", reject));
    wsFailed.catch(() => {}); // 无人 await 时也不许炸进程

    for await (const chunk of res.body) {
      down += chunk.length;
      if (!ws.write(chunk)) {
        await Promise.race([new Promise((r) => ws.once("drain", r)), wsFailed]);
      }
      const now = Date.now();
      if (onProgress && now - lastTick >= 400) {
        const speed = ((down - lastDown) * 1000) / Math.max(1, now - lastTick);
        lastTick = now;
        lastDown = down;
        try {
          onProgress({ down, total, speed, done: false });
        } catch {
          /* 进度回调炸了不影响下载 */
        }
      }
    }

    await Promise.race([new Promise((r) => ws.end(r)), wsFailed]);
    await rename(partFile, destPath);
    const st = await stat(destPath);
    if (!total) total = st.size;
    try {
      onProgress?.({ down, total, speed: 0, done: true });
    } catch {
      /* ignore */
    }
    return { size: st.size };
  } catch (e) {
    await rm(partFile, { force: true }).catch(() => {});
    throw e;
  }
}

export default downloadToFile;
