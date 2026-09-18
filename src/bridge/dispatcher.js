/**
 * 命令分发器 —— open-orpheus `src/CallDispatcher.ts` 的服务端移植版。
 *
 * 这是整个桥接层的核心：它是一张"命令 → 处理函数"的路由表，
 * 完全不知道传输层存在（原版跑在 Electron IPC 上，这里跑在 WebSocket 上）。
 *
 * 网易云前端调用的全部宿主 API（app.* / os.* / player.* / storage.* …）
 * 都注册在这张表上。
 */
export default class CallDispatcher {
  /** @type {Record<string, Function>} */
  handlers = Object.create(null);
  /** @type {Record<string, Function>} */
  callbackHandlers = Object.create(null);

  /**
   * 注册一个普通处理函数。
   * @param {string} cmd 形如 "player.setLyrics"
   * @param {Function} handler (...args) => unknown[] | Promise<unknown[]>
   */
  registerHandler(cmd, handler) {
    this.handlers[cmd] = handler;
  }

  /** 批量注册：{ "app.exit": fn, ... } */
  registerHandlers(handlers) {
    for (const [cmd, handler] of Object.entries(handlers)) {
      this.registerHandler(cmd, handler);
    }
  }

  /**
   * 注册"回调型"处理（需要主动多次回传，例如存储扫描进度）。
   * @param {string} cmd
   * @param {(callback: Function, ...args: unknown[]) => unknown} handler
   */
  registerCallbackHandler(cmd, handler) {
    this.callbackHandlers[cmd] = handler;
  }

  has(cmd) {
    return Boolean(this.callbackHandlers[cmd] || this.handlers[cmd]);
  }

  /**
   * 分发。回调型优先。
   * @returns {Promise<void|false>} 没有对应 handler 时返回 false
   */
  async dispatch(cmd, callback, ...args) {
    const callbackHandler = this.callbackHandlers[cmd];
    if (callbackHandler) {
      await callbackHandler(callback, ...args);
      return;
    }
    const handler = this.handlers[cmd];
    if (!handler) {
      return false;
    }
    const result = await handler(...args);
    callback.call(undefined, ...(Array.isArray(result) ? result : []));
  }
}
