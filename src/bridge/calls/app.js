/**
 * app.* / localconfig / settings
 * ================================
 * `app.getLocalConfig` / `app.setLocalConfig` 是**关键**：官方前端把
 * apiDomain / encrypt / proxy / features 等一票运行时配置存在原生侧，
 * 启动时读回来。Web 版必须给出可用值，否则启动流程会走岔。
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import createLogger from "../../logger.js";

const log = createLogger("call:app");

/** 归一化 getLocalConfig 的两种调用形态 */
function parseArgs(a, b) {
  if (a && typeof a === "object") {
    return { type: String(a.type ?? ""), key: String(a.key ?? "") };
  }
  return { type: String(a ?? ""), key: String(b ?? "") };
}

export function makeAppCalls(ctx) {
  const file = join(ctx.dataDir, "localconfig.json");
  let store = null;

  const load = () => {
    if (store) return store;
    try {
      store = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    } catch {
      store = {};
    }
    return store;
  };

  let saveTimer = null;
  const save = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        await writeFile(file, JSON.stringify(load(), null, 2), "utf8");
      } catch (e) {
        log.warn(`保存 localconfig 失败: ${e.message}`);
      }
    }, 300);
  };

  const get = (type, key, sub) => {
    const s = load();
    const bucket = s[type] || {};
    if (!key) return bucket;
    if (sub === undefined || sub === null || sub === "") return bucket[key];
    return (bucket[key] || {})[sub];
  };

  const set = (type, key, value) => {
    const s = load();
    s[type] = s[type] || {};
    if (!key) s[type] = value;
    else s[type][key] = value;
    save();
  };

  const ack = () => [];
  const no = () => [false];

  return {
    /* ─── 本地配置 ─── */
    "app.getLocalConfig": (a, b) => {
      const { type, key } = parseArgs(a, b);
      const hit = get(type, key);
      // 官方约定：返回 JSON 字符串；无值返回空串
      if (hit === undefined || hit === null) return [""];
      return [typeof hit === "string" ? hit : JSON.stringify(hit)];
    },
    "app.setLocalConfig": (type, key, value) => {
      set(String(type ?? ""), String(key ?? ""), value);
      return [];
    },
    "app.getNativeData": () => [""],
    "app.setCustomInfo": (info) => {
      set("customInfo", "value", info);
      return [];
    },

    /* ─── 启动 / 生命周期 ─── */
    "app.getAppStartTime": () => [ctx.startTime],
    "app.getAppStartType": () => ["app"],
    "app.getAppStartCommand": () => [""],
    "app.getAppStartCommandParams": () => [""],
    "app.onBootFinish": () => {
      ctx.emit("app.onBootFinish", []);
      return [];
    },
    "app.exit": () => {
      log.info("前端请求退出（Web 环境忽略）");
      return [];
    },
    "app.appStartUpEnd": ack,
    "app.enableProcessMonitor": ack,

    /* ─── 窗口 / 系统集成：Web 无对应物 ─── */
    "app.setThumbnail": ack,
    "app.isAppFulllScreen": no,
    "app.systemUIHint": ack,
    "app.systemVoiceHint": ack,
    "app.tipsAuthMicroPhone": no,
    "app.setAutoRun": ack,
    "app.cancelAutoRun": ack,
    "app.getAutoRunState": no,
    "app.isRegisterDefaultClient": no,
    "app.registerDefaultClient": ack,
    "app.unRegisterDefaultClient": ack,
    "app.testProxy": no,
    /**
     * ⚠️ 不能用 `ack`（= `[]`）。
     *
     * SDK 侧的调用是"直接回调 + 看真假"：
     *   At.call("app.loadSkinPackets", type, name, extra, cb)
     *   => cb(t);  t || reject("[native-rpc] App.loadSkinAssets(...) error.")
     * `[]` 意味着回调 0 个参数 → t 是 undefined → 直接 reject。
     * 而 `i.App.loadSkinAssets(a)` 既不 await 也不 catch，
     * 于是每次启动都甩两条 unhandled rejection。
     * 皮肤包本身解不出来，但必须答"成功"。
     */
    "app.loadSkinPackets": () => [true],
    "app.chooseColor": () => [""],

    /* ─── 上报 / ABTest：全部静默吞掉，别往服务端送 ─── */
    "app.log": ack,
    "app.statis": ack,
    "app.statisV2": ack,
    "app.sendStatis": ack,
    "app.perfReport": ack,
    "app.sendFeedback": ack,
    "app.getABTestKeys": () => [JSON.stringify([])],
    "app.abtestSwitch": no,
    "app.abtestSwitchV2": no,
    "app.featuresSwitch": no,
    "app.getCooperation": () => [""],
    "app.getP2PUrl": () => [""],
    "app.initUrls": ack,

    /* ─── 文件选择 / 听歌识曲：浏览器里用 input[type=file] 兜底，先留空 ─── */
    "app.getDefaultMusicPlayPath": () => [""],
    "app.scanMusicFile": ack,
    "app.recognizeMusic": () => [false],
    "app.stopRecognizeMusic": ack,
    "app.createRecognizeShutcut": ack,
    "app.feedbackRecognizeMusicResult": ack,
    "app.clearRecognizeMusicCache": ack,
    "app.selectSystemDir": () => [""],
    "app.selectSystemFileAndDir": () => [""],
    "app.selectSystemFileLimitCount": () => [""],
    "app.openSaveFileDialog": () => [""],
    "app.compress": () => [null],
  };
}

export default makeAppCalls;
