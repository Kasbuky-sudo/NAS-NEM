/*!
 * NAS-NEM 前端 shim
 * ==================
 * 在官方前端脚本之前同步注入。职责三件事：
 *
 *  1. 实现 `window.channel` —— 官方前端的宿主桥契约。
 *     官方客户端由 CEF 注入这个对象（含原生 `viewCall`），我们用一个 WebSocket 顶替。
 *     注意 `viewCall` 必须存在：新 SDK（dbg.Command）用
 *         !window.webkit && !(window.channel && window.channel.viewCall)
 *     来判定自己是跑在 CEF 里还是"调试 socket 模式"。我们给出 viewCall 让它走
 *     正常路径（Bridge.call → window.channel.call），而不是它自带的 socket 协议。
 *
 *  2. URL 改写
 *     - `orpheus://…` → 同源 `/orpheus/…`（浏览器不认自定义协议）
 *     - 网易 API 域名（music.163.com / interface*.163.com / *.126.net …）
 *       → 同源 `/__p/<host>/<path>`，由服务端反向代理转发并托管 cookie，
 *         彻底绕开 CORS。
 *
 *  3. 本地实现 `player.*` —— 官方播放器是原生组件，浏览器里没有。
 *     这些命令在客户端用 <audio> 直接办掉，不往服务端绕。
 *
 * 协议（本 shim ↔ 服务端 WebSocket）
 *   出：{ id, type:"call", cmd, args }
 *   入：{ id, type:"result", data:[...] } | { id, type:"error", message }
 *       { type:"event", name:"player.onLyrics", args:[...] }
 */
(function () {
  "use strict";

  var W = window;
  if (W.__NASNEM__) return;

  var ORPHEUS = "orpheus://";
  var ORPHEUS_HTTP = "/orpheus/";

  /* 需要走服务端反向代理的网易域名（与 src/config.js 的 allowedApiHosts 对齐） */
  var PROXY_SUFFIXES = ["163.com", "126.net", "netease.com", "163yun.com", "127.net"];

  var state = {
    ws: null,
    seq: 0,
    pending: new Map(),
    listeners: new Map(),
    queue: [],
  };
  W.__NASNEM__ = state;

  /* ───────────────── 入口判定（必须在所有 bundle 之前定好） ─────────────────
   * 官方前端有一处「我是不是主窗口」的判定：
   *     isMainWindow: !!isWeb || "orpheus://orpheus/pub/app.html" === location.href
   * 浏览器里 location.href 永远是 http(s) 全量地址，这个比较恒为 false，
   * 而 isMainWindow 挂着主路由注册 / 全局 dispatch / 起始任务编排 —— 为 false 直接白屏。
   * 服务端改写层把这个表达式换成了 window.__NASNEM_IS_MAIN__，这里负责赋值。
   *
   * 入口对应关系（pub 目录下的 html）：
   *     app.html / index.html  → 主窗口
   *     subApp.html            → 子窗口
   *     checkdata.html / 404.html → 工具页，按子窗口处理
   * 允许用 ?__main=0/1 手动覆盖，方便调试子窗口。
   */
  (function () {
    var entry = "";
    try {
      entry = (W.location.pathname.split("/").pop() || "").toLowerCase();
    } catch (e) {
      /* ignore */
    }
    var isMain = entry === "app.html" || entry === "index.html" || entry === "";
    var m = /[?&]__main=([01])/.exec(W.location.search || "");
    if (m) isMain = m[1] === "1";
    W.__NASNEM_IS_MAIN__ = isMain;
    W.__NASNEM_ENTRY__ = entry;
  })();

  /* ─────────────────────────── URL 改写 ─────────────────────────── */

  function rewriteOrpheus(u) {
    if (u.slice(0, ORPHEUS.length) === ORPHEUS) {
      return ORPHEUS_HTTP + u.slice(ORPHEUS.length);
    }
    return u;
  }

  function needsProxy(host) {
    for (var i = 0; i < PROXY_SUFFIXES.length; i++) {
      var s = PROXY_SUFFIXES[i];
      if (host === s || host.slice(-(s.length + 1)) === "." + s) return true;
    }
    return false;
  }

  /** 把绝对 URL 收敛成同源地址 */
  function toLocal(u) {
    if (typeof u !== "string" || !u) return u;
    if (u.slice(0, ORPHEUS.length) === ORPHEUS) return ORPHEUS_HTTP + u.slice(ORPHEUS.length);
    if (u.slice(0, 2) === "//") {
      // 协议相对
      var h0 = u.slice(2).split("/")[0].split("?")[0];
      if (needsProxy(h0)) return "/__p/" + u.slice(2);
      return W.location.protocol + u;
    }
    if (u.slice(0, 5) !== "http:" && u.slice(0, 6) !== "https:") return u;
    var a;
    try {
      a = new URL(u);
    } catch (e) {
      return u;
    }
    if (a.origin === W.location.origin) return u;
    if (needsProxy(a.host)) return "/__p/" + a.host + a.pathname + a.search + a.hash;
    return u;
  }

  state.toLocal = toLocal;

  /** 改写一个"URL 消费者"的属性 setter */
  function patchProp(proto, prop) {
    if (!proto) return;
    var d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    try {
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set: function (v) {
          return d.set.call(this, toLocal(v));
        },
      });
    } catch (e) {
      /* ignore */
    }
  }

  [
    W.HTMLImageElement,
    W.HTMLScriptElement,
    W.HTMLMediaElement,
    W.HTMLSourceElement,
    W.HTMLLinkElement,
    W.HTMLIFrameElement,
    W.HTMLTrackElement,
    W.HTMLEmbedElement,
    W.HTMLObjectElement,
    W.HTMLVideoElement,
    W.HTMLAudioElement,
  ].forEach(function (p) {
    patchProp(p, "src");
    patchProp(p, "href");
    patchProp(p, "data");
  });

  /* setAttribute 兜底（含 new Audio(url) 这种走属性表的路径） */
  var _setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (typeof value === "string") {
      var n = String(name).toLowerCase();
      if (n === "src" || n === "href" || n === "data" || n === "poster") {
        value = toLocal(value);
      }
    }
    return _setAttribute.call(this, name, value);
  };

  /* Audio 构造器 */
  var _Audio = W.Audio;
  if (_Audio) {
    function PatchedAudio(src) {
      var el = arguments.length ? new _Audio(toLocal(src)) : new _Audio();
      return el;
    }
    PatchedAudio.prototype = _Audio.prototype;
    try {
      W.Audio = PatchedAudio;
    } catch (e) {
      /* ignore */
    }
  }

  /* fetch */
  var _fetch = W.fetch;
  if (_fetch) {
    W.fetch = function (input, init) {
      if (typeof input === "string") input = toLocal(input);
      else if (input && input.url && typeof Request !== "undefined" && input instanceof Request) {
        var fixed = toLocal(input.url);
        if (fixed !== input.url) input = new Request(fixed, input);
      }
      return _fetch.call(this, input, init);
    };
  }

  /* XMLHttpRequest */
  if (W.XMLHttpRequest) {
    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var rest = Array.prototype.slice.call(arguments, 2);
      return _open.apply(this, [method, toLocal(url)].concat(rest));
    };
  }

  /* sendBeacon / EventSource / window.open / Worker */
  if (navigator.sendBeacon) {
    var _beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      return _beacon(toLocal(url), data);
    };
  }
  if (W.EventSource) {
    var _ES = W.EventSource;
    W.EventSource = function (url, cfg) {
      return new _ES(toLocal(url), cfg);
    };
    W.EventSource.prototype = _ES.prototype;
  }
  var _openWin = W.open;
  W.open = function (url) {
    var rest = Array.prototype.slice.call(arguments, 1);
    return _openWin.apply(W, [typeof url === "string" ? toLocal(url) : url].concat(rest));
  };

  /* CSSStyleDeclaration / 内联 style 里的 url() —— 官方 CSS 里没有 orpheus://，留个兜底 */
  var _cssText = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, "cssText");
  if (_cssText && _cssText.set) {
    Object.defineProperty(CSSStyleDeclaration.prototype, "cssText", {
      configurable: true,
      enumerable: _cssText.enumerable,
      get: _cssText.get,
      set: function (v) {
        return _cssText.set.call(
          this,
          String(v).replace(/orpheus:\/\//g, ORPHEUS_HTTP)
        );
      },
    });
  }

  /* ─────────────────────── 本地命令（player 等） ─────────────────────── */

  /**
   * 官方播放器是原生组件；这里用 <audio> 顶上。
   * 前端调 player.setCurrentPlay / setCurrentTime / setVolume / mute …
   */
  /* ─────────────────────── 本地命令（播放器）───────────────────────
   *
   * ⚠️ 官方 PC 客户端有**两套**播放器命令，别搞混：
   *   - `player.*`      ：界面状态同步（歌词、封面、试听列表、mini 播放器），不出声
   *   - `audioplayer.*` ：真正驱动解码播放的那一套（load / play / pause / seek / setVolume）
   * 只实现 `player.*` 的后果非常有迷惑性：播放列表、歌曲名、进度条 UI 全都正常更新，
   * 但页面上从来没有 <audio>，永远没声音 —— 这正是"能进播放列表但是不播放"的根因。
   *
   * audioplayer 的契约（参数与回推事件）参照上游 open-orpheus 对齐，
   * 浏览器侧用一个隐藏的 <audio> 元素顶替原生解码器。
   */
  var AP = { Null: 0, Playing: 1, Paused: 2, Error: 3 };

  var player = {
    el: null,
    ready: false,
    volume: 1,
    muted: false,
    currentId: "",
    info: null,
    /** 本次 load 是否已回过 onLoad —— 重复回会让前端重复触发 play */
    loadedSent: false,
    guard: 0,
  };

  function tryJson(v) {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch (e) {
      return null;
    }
  }

  /** 从 playInfo 里挖出音源 URL：在线走 musicurl，本地走 path */
  function apUrl(info) {
    if (!info) return "";
    var u = "";
    if (info.type === 0) u = info.path || info.url || "";
    else u = info.musicurl || info.url || info.path || "";
    return toLocal(u);
  }

  function emitLocal(name, args) {
    state.emitLocal(name, args || []);
  }

  function sendOnLoad(duration) {
    if (player.loadedSent) return;
    player.loadedSent = true;
    emitLocal("audioplayer.onLoad", [
      player.currentId,
      {
        activeCode: 0,
        code: 0,
        duration: duration || 0,
        errorCode: 0,
        errorString: "",
        openWholeCached: true,
        preloadWholeCached: false,
      },
    ]);
  }

  function playerEl() {
    if (player.el) return player.el;
    var a = document.createElement("audio");
    a.preload = "auto";
    a.setAttribute("playsinline", "");
    a.style.display = "none";
    (document.body || document.documentElement).appendChild(a);
    player.el = a;
    a.volume = player.volume;

    var emit = emitLocal;
    a.addEventListener("loadedmetadata", function () {
      /* 加载就绪 → 回 onLoad，前端拿到 code:0 才会继续调 audioplayer.play */
      sendOnLoad(a.duration || 0);
      emit("player.onDuration", [(a.duration || 0) * 1000]);
    });
    a.addEventListener("play", function () {
      emit("audioplayer.onPlayState", [player.currentId, "", AP.Playing]);
      emit("player.onPlayState", [1]);
    });
    a.addEventListener("pause", function () {
      emit("audioplayer.onPlayState", [player.currentId, "", AP.Paused]);
      emit("player.onPlayState", [2]);
    });
    a.addEventListener("ended", function () {
      var ms = (a.duration || 0) * 1000;
      emit("audioplayer.onEnd", [
        player.currentId,
        { activeCode: 0, code: 0, errorCode: 0, errorString: "", playedAudioTime: ms, playedTime: ms },
      ]);
      emit("player.onEnded", []);
    });
    a.addEventListener("timeupdate", function () {
      emit("audioplayer.onPlayProgress", [player.currentId, a.currentTime, 0]);
      emit("player.onProgress", [a.currentTime * 1000, (a.duration || 0) * 1000]);
    });
    a.addEventListener("seeked", function () {
      emit("audioplayer.onSeek", [player.currentId, "", 0, a.currentTime]);
    });
    a.addEventListener("waiting", function () {
      emit("audioplayer.onBuffering", [player.currentId, 1]);
    });
    a.addEventListener("playing", function () {
      emit("audioplayer.onBuffering", [player.currentId, 0]);
    });
    a.addEventListener("error", function () {
      var ms = (a.currentTime || 0) * 1000;
      emit("audioplayer.onEnd", [
        player.currentId,
        { activeCode: 6, code: 2, errorCode: 3, errorString: "", playedAudioTime: ms, playedTime: ms },
      ]);
      emit("player.onError", [-1, "audio error"]);
    });
    a.addEventListener("volumechange", function () {
      emit("audioplayer.onVolume", [player.currentId, "", 0, a.volume]);
      emit("player.onVolume", [a.volume * 100]);
    });
    return a;
  }

  /* ─────────────── 子窗口（登录弹窗 / 迷你程序）───────────────
   *
   * 官方客户端里，登录弹窗**不是**页面内的一个 <div>，而是另一个**原生窗口**：
   *     app/modalOpen({route:"login"}) → winhelper.launchWindow("subApp.html?route=login&uuid=…")
   * 这正是网页版能不能登录的分水岭。之前 `winhelper.*` 被归进"网页里没有、
   * 静默吞掉就行"那一类，于是连成下面这条因果链：
   *   ① 窗口没开       → ② 前端 saga 早已先 toast「登录弹窗启动中」并挂起等待
   *   `closeLoginWindow` → ③ 永远等不到 → 用户看到的就是一个卡死的提示条。
   *
   * 浏览器里没有原生窗口，这里用**页面内浮层 iframe** 顶替：
   *   - 子窗口仍是官方 subApp.html（shim 按入口名判定 __NASNEM_IS_MAIN__=false，
   *     因此会正确渲染成子窗口内容）；
   *   - 登录走到终点时，子界面会进自己的 `/leavePage/true` 路由 → 调
   *     `winhelper.destroyWindow()` → 因为它是 iframe，这里 postMessage 通知父页关闭；
   *   - 父页收到后移除浮层并刷新一次，让主界面挂上新的登录态。
   */
  var WIN_ID = "__nasnem_win_layer";
  var subWin = { layer: null, frame: null };

  /** @param {boolean} byUser 是否由用户（点遮罩）触发；用户主动关闭不刷新页面 */
  function destroySubWindow(byUser) {
    var layer = subWin.layer;
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    subWin.layer = null;
    subWin.frame = null;
    if (byUser) return;
    /* 子窗口自己走完流程（多为登录完成）→ 主界面重载一次，重新拉取登录态 */
    try {
      W.location.reload();
    } catch (e) {
      /* ignore */
    }
  }

  function openSubWindow(url, pos, opts) {
    try {
      destroySubWindow(true);
      var host = document.body || document.documentElement;
      if (!host) return;
      var o = opts || {};
      var p = pos || {};
      var w = Number(p.width || o.width) || 0;
      var h = Number(p.height || o.height) || 0;
      if (!w) w = 376;
      if (!h) h = 520;
      var maxW = W.innerWidth || 1024;
      var maxH = W.innerHeight || 768;
      if (w > maxW - 24) w = Math.max(320, maxW - 24);
      if (h > maxH - 24) h = Math.max(240, maxH - 24);
      var br = parseInt(o.borderRadius, 10);
      if (!br || br < 0) br = 12;

      var layer = document.createElement("div");
      layer.id = WIN_ID;
      layer.style.cssText =
        "position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483000;" +
        "display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);";

      var box = document.createElement("div");
      box.style.cssText =
        "position:relative;width:" + w + "px;height:" + h + "px;max-width:96vw;max-height:92vh;" +
        "overflow:hidden;border-radius:" + br + "px;background:" + (o.backgroundColor || "#fff") + ";" +
        "box-shadow:0 12px 48px rgba(0,0,0,.45);";

      var frame = document.createElement("iframe");
      frame.src = toLocal(String(url || ""));
      frame.style.cssText = "width:100%;height:100%;border:0;display:block;background:transparent;";
      frame.setAttribute("allow", "autoplay; clipboard-write; encrypted-media; picture-in-picture");

      box.appendChild(frame);
      layer.appendChild(box);
      layer.addEventListener("click", function (e) {
        if (e.target === layer) destroySubWindow(true);
      });
      host.appendChild(layer);
      subWin.layer = layer;
      subWin.frame = frame;
    } catch (e) {
      /* ignore */
    }
  }

  W.addEventListener("message", function (e) {
    var d = e && e.data;
    if (!d || typeof d !== "object") return;
    if (d.__nasnem === "closeWindow") destroySubWindow();
  });

  /** getPlaybackInfo 的空壳：宿主不采集播放质量数据，字段照官方形状补齐即可 */
  function apPlaybackInfo() {
    return {
      cacheStrategyCode: "",
      cdnUsed: false,
      deviceAudioFormat: { channels: 0, samplerate: 0, samplesize: 0 },
      hasNetworkJanks: false,
      hasSeekJanks: false,
      hasSystemJanks: false,
      p2pUsed: false,
      playAudioFormat: { channels: 0, samplerate: 0, samplesize: 0 },
      playId: player.currentId || "",
      playedPercent: 0,
      playedTime: 0,
      preloadWholeCached: false,
      result: false,
      souceType: 0,
      sourceAudioFormat: { channels: 0, samplerate: 0, samplesize: 0 },
      strategyCode: "",
      wholeCached: true,
    };
  }

  var localHandlers = {
    /* ---- audioplayer：真正的解码播放（不出声的元凶就在这里）---- */

    /**
     * `audioplayer.load(playId, playInfo)`
     * playInfo.type === 0 → 本地文件，看 `path`
     * playInfo.type === 4 → 在线音源，看 `musicurl`
     *
     * ⚠️ 加载完**必须**回一次 `audioplayer.onLoad` 且 code 为 0：
     * 前端 SDK 是先 `overwriteRegisterCall("Load","audioplayer",resolve)` 再发 load，
     * 不回回调 → 它的 Promise 永远 pending → 后面那句 `audioplayer.play` 根本不会发。
     */
    "audioplayer.load": function (id, playInfo) {
      var el = playerEl();
      var info = tryJson(playInfo);
      player.currentId = String(id || (info && info.playId) || "");
      player.info = info || null;
      player.loadedSent = false;

      var u = apUrl(info);
      try {
        if (u) {
          el.src = u;
          el.load();
        }
      } catch (e) {
        /* ignore */
      }

      /* 兜底：拿不到 URL / 事件没触发时也要回调，绝不让前端挂着 */
      var myId = ++player.guard;
      setTimeout(function () {
        if (myId === player.guard) sendOnLoad(el.duration || 0);
      }, 1200);
      if (!u) sendOnLoad(0);
      return [];
    },
    /** URL 过期后宿主会重新下发；只处理"还是当前这首"的结果 */
    "audioplayer.setRefreshSongUrlResult": function (result) {
      var info = tryJson(result);
      if (info && player.currentId && String(info.playId) !== player.currentId) return [];
      return localHandlers["audioplayer.load"](info && info.playId, info);
    },
    "audioplayer.play": function (id) {
      var el = playerEl();
      if (id && player.currentId && String(id) !== player.currentId) {
        /* 与官方一致：id 对不上就忽略，避免切歌时误播上一首 */
        return [];
      }
      try {
        var p = el.play();
        if (p && p.catch) p.catch(function () {});
      } catch (e) {
        /* ignore */
      }
      return [];
    },
    "audioplayer.pause": function (id) {
      if (id && player.currentId && String(id) !== player.currentId) return [];
      if (player.el) player.el.pause();
      return [];
    },
    "audioplayer.stop": function (id) {
      if (id && player.currentId && String(id) !== player.currentId) return [];
      if (player.el) {
        player.el.pause();
        try {
          player.el.currentTime = 0;
        } catch (e) {
          /* ignore */
        }
      }
      return [];
    },
    /**
     * `audioplayer.seek(playId, opId, time)`
     * time 的单位两种实现都见过：这里按"超过 1000 就当毫秒"来兜，
     * 免得拖动进度条直接跳到曲子末尾。
     */
    "audioplayer.seek": function (id, opId, time) {
      var el = playerEl();
      var t = Number(time) || 0;
      if (t > 1000) t = t / 1000;
      try {
        if (isFinite(el.duration)) el.currentTime = Math.max(0, Math.min(el.duration, t));
      } catch (e) {
        /* ignore */
      }
      return [];
    },
    /** 官方签名是 (a, b, volume)，音量在**第三个**参数，取值 0~1 */
    "audioplayer.setVolume": function (a, b, v) {
      var el = playerEl();
      var n = Number(v);
      if (!isFinite(n)) return [];
      if (n > 1) n = n / 100;
      player.volume = Math.min(1, Math.max(0, n));
      el.volume = player.volume;
      return [];
    },
    "audioplayer.setPlaybackRate": function (r) {
      try {
        playerEl().playbackRate = Number(r) || 1;
      } catch (e) {
        /* ignore */
      }
      return [];
    },
    "audioplayer.getPlayedTime": function () {
      var t = player.el ? player.el.currentTime || 0 : 0;
      return [{ playedAudioTime: t, playedTime: t, result: true }];
    },
    "audioplayer.getPlaybackInfo": function () {
      return [apPlaybackInfo()];
    },
    /**
     * `isDeviceMute` 之后前端会用 `CheckDeviceMute` 注册一次性回调等待结果，
     * 不回这个事件它就会永久 pending。
     */
    "audioplayer.isDeviceMute": function () {
      setTimeout(function () {
        emitLocal("audioplayer.onCheckDeviceMute", [false, 0]);
      }, 0);
      return [false];
    },
    "audioplayer.getSystemMasterVolume": function () {
      return [{ muted: false, realVolume: 1, volume: 1 }];
    },
    "audioplayer.getApplicationVolume": function () {
      return [player.volume];
    },
    "audioplayer.getSystemAudioEnhance": function () {
      return [false];
    },
    "audioplayer.setSystemAudioEnhance": function () {
      return [];
    },
    "audioplayer.getSystemSpatialSound": function () {
      return [{ result: false }];
    },
    "audioplayer.setSystemSpatialSound": function () {
      return [];
    },
    "audioplayer.immerseSurroundSupport": function () {
      return [{ result: false }];
    },
    "audioplayer.immerseSurroundSupportWatch": function () {
      return [];
    },
    "audioplayer.init": function () {
      return [];
    },
    "audioplayer.initAIProcessor": function () {
      return [];
    },
    "audioplayer.testAIProcessor": function () {
      return [{ result: false }];
    },
    "audioplayer.enmeratorDevices": function () {
      setTimeout(function () {
        emitLocal("audioplayer.onEnmeratorDevices", [
          "getOutDevices",
          [{ type: "WebAudio", devices: [] }],
          { deviceId: "default", id: -1, type: "WebAudio", name: "Default" },
        ]);
      }, 0);
      return [];
    },
    "audioplayer.preLoad": function () {
      return [];
    },
    "audioplayer.setFetchPreloadInfoResult": function () {
      return [];
    },
    "audioplayer.enableAudioData": function () {
      return [];
    },
    "audioplayer.setAudioStrategy": function () {
      return [];
    },
    "audioplayer.switchEffect": function () {
      return [];
    },

    /* ---- player ---- */
    "player.setCurrentPlay": function (url, id, autoplay) {
      var el = playerEl();
      if (url) {
        var src = toLocal(url);
        if (el.src !== src) {
          el.src = src;
          el.load();
        }
      }
      if (id !== undefined) player.el.dataset.trackId = String(id);
      if (autoplay !== false) el.play().catch(function () {});
      return [];
    },
    "player.play": function () {
      playerEl().play().catch(function () {});
      return [];
    },
    "player.pause": function () {
      if (player.el) player.el.pause();
      return [];
    },
    "player.setCurrentTime": function (ms) {
      if (player.el && isFinite(ms)) player.el.currentTime = Math.max(0, ms / 1000);
      return [];
    },
    "player.setVolume": function (v) {
      var el = playerEl();
      var n = Number(v);
      if (n > 1) n = n / 100;
      el.volume = Math.min(1, Math.max(0, n));
      return [];
    },
    "player.mute": function (m) {
      var el = playerEl();
      el.muted = m === true || m === 1 || m === "1";
      return [];
    },
    "player.setTotalTime": function () {
      return [];
    },
    "player.setInfo": function () {
      return [];
    },
    "player.setCover": function () {
      return [];
    },
    "player.setCoverDefault": function () {
      return [];
    },
    "player.setFavour": function () {
      return [];
    },
    "player.setLikeMark": function () {
      return [];
    },
    "player.setLyrics": function () {
      return [];
    },
    "player.setOffset": function () {
      return [];
    },
    "player.setAlwaysOnTop": function () {
      return [];
    },
    "player.setMiniPlayerState": function () {
      return [];
    },
    "player.setLRCColor": function () {
      return [];
    },
    "player.setLRCFont": function () {
      return [];
    },
    "player.setLRCDJ": function () {
      return [];
    },
    "player.setLRCEmpty": function () {
      return [];
    },
    "player.setLRCSlogan": function () {
      return [];
    },
    "player.setOutlineColor": function () {
      return [];
    },
    "player.setOutlineShadow": function () {
      return [];
    },
    "player.setFont": function () {
      return [];
    },
    "player.setTextAlign": function () {
      return [];
    },
    "player.setLineMode": function () {
      return [];
    },
    "player.setLock": function () {
      return [];
    },
    "player.setMusicOnly": function () {
      return [];
    },
    "player.setDesktopLyricTopMost": function () {
      return [];
    },
    "player.setMiniTogetherStatus": function () {
      return [];
    },
    "player.setSMTCEnable": function () {
      return [];
    },
    "player.showTranslateLyric": function () {
      return [];
    },
    "player.showHorizontalLyric": function () {
      return [];
    },
    "player.showVolume": function () {
      return [];
    },
    "player.updateTooltips": function () {
      return [];
    },
    "player.simulateKRC": function () {
      return [];
    },
    "player.getId": function () {
      return ["nasnem-web"];
    },
    "player.renderLRCImage": function () {
      return [null, 0];
    },
    "player.addListElement": function () {
      return [];
    },
    "player.deleteListElement": function () {
      return [];
    },
    "player.removeAll": function () {
      return [];
    },

    /* ---- os / app：浏览器里能直接答的，本地答，省一次往返 ---- */

    /**
     * ⚠️ `os.getDeviceId` / `os.getADDeviceID` **故意不在这里本地答**。
     *
     * 它们曾经返回 `state.deviceId || ""`，而 `state.deviceId` 从来没有被赋过值，
     * 于是恒为空串。后果是一条很长的因果链：
     *     官方 NativeApp.encodeAnonymousId(e) 开头就是 `if (!e) return ""`
     *       → 空 deviceId 直接返回空串，根本不走桥接（trace 里看不到该命令）
     *       → 空串被当成 username 发给 /api/register/anonimous
     *       → 服务端回 {"code":400}，匿名登录失败
     *       → 首页/推荐/歌单广场全部"数据加载失败"
     * 所以这里不拦，原样转发给服务端。
     *
     * 为什么不干脆在浏览器里随机生成一个？因为 deviceId 是要参与
     * 请求头/加密参数、并且必须**跨会话稳定**的，服务端已把它持久化在
     * `data/<session>/deviceid`。前端缓存一份（Os.deviceId），整个会话只问一次。
     */

    /**
     * ⚠️ 形状对齐官方（bundle 里的兜底常量就是它）：
     *   {factor, monitor:{x,y,width,height}, monitorName, workArea:{x,y,width,height}}
     * 前端 `configWindowPosition` 直接取 `.workArea.width/height`。
     * 这里**绝对不能** JSON.stringify —— 那样 `.workArea` 是 undefined，
     * 下一行 `t.width` 就 "Cannot read properties of undefined (reading 'width')"。
     */
    "os.getSystemInfo": function () {
      return [
        {
          factor: 1,
          monitor: { x: 0, y: 0, width: screen.width, height: screen.height },
          monitorName: "浏览器窗口",
          workArea: { x: 0, y: 0, width: screen.availWidth, height: screen.availHeight },
          platform: "web",
          os: "pc",
          osver: "14.7.0",
          arch: navigator.userAgent,
          totalmem: navigator.deviceMemory ? navigator.deviceMemory * 1e9 : 0,
          cpus: navigator.hardwareConcurrency || 4,
        },
      ];
    },
    /**
     * ⚠️ 系统版本闸门的安全值，别改小了。
     *
     * app.chunk 里的 isLowerOSX10_14 是 `(d<=10 && f<14)`，而它是那批
     * isLowerOSX* 里唯一漏写 `isOSX &&` 的 —— 会拿 macOS 尺子量所有平台。
     * `d/f/p` 取自本函数的返回，所以这里必须给 major > 10 的值，
     * 否则 SubAppContent 会直接渲染 lowOSXVersionBlank.png（整页白屏）。
     * 14 落在 (10, 15)：既过闸门，又不会误点亮 isUpperOSx15_2 的 15.2+ 特性。
     * 服务端 src/bridge/calls/os.js 里有一份同样的常量，两边要一致。
     */
    "os.queryOsVer": function () {
      return ["14.7.0"];
    },
    "os.isOnLine": function () {
      return [navigator.onLine];
    },
    "os.isSystemDarkThemeEnabled": function () {
      try {
        return [W.matchMedia("(prefers-color-scheme: dark)").matches];
      } catch (e) {
        return [false];
      }
    },
    /** 官方回调拿到的是 JSON 字符串：`JSON.parse(e).free` */
    "os.getDiskSpace": function () {
      return [JSON.stringify({ free: 0, total: 0 })];
    },
    /**
     * ⚠️ 必须是**真数组**：前端 `t.forEach(e => {e.isPrimary ? ...})`
     *    再 `t.some(e => e.deviceId === o)`。给 JSON 字符串 → `t.forEach is not a function`。
     */
    "os.getAllDisplayInfo": function () {
      return [
        [
          {
            x: 0,
            y: 0,
            width: screen.width,
            height: screen.height,
            scale: devicePixelRatio || 1,
            factor: 1,
            deviceId: "primary",
            name: "浏览器窗口",
            monitorName: "浏览器窗口",
            isPrimary: true,
            workArea: { x: 0, y: 0, width: screen.availWidth, height: screen.availHeight },
          },
        ],
      ];
    },
    "os.navigateExternal": function (url) {
      var u = String(url || "");
      // 官方设定：http(s) 走外链，自定义协议交回给前端路由
      if (/^https?:/i.test(u)) W.open(u, "_blank", "noopener");
      return [true];
    },
    "os.shellOpen": function () {
      return [true];
    },
    "os.shellExplor": function () {
      return [true];
    },
    /** 官方约定：回调 ≥2 个参数时前端拿到的是参数数组 → ["success", fonts] */
    "os.checkNativeSupportFonts": function () {
      return ["success", []];
    },
    "os.querySystemFonts": function () {
      return ["success", []];
    },

    "app.getAppStartTime": function () {
      return [state.startTime || Date.now()];
    },
    "app.getAppStartType": function () {
      return ["app"];
    },
    "app.getAppStartCommand": function () {
      return [""];
    },
    "app.isAppFulllScreen": function () {
      return [false];
    },
    "app.getNativeData": function () {
      return [""];
    },
    "app.setThumbnail": function () {
      return [];
    },
    "app.log": function () {
      return [];
    },
    "app.sendStatis": function () {
      return [];
    },
    "app.statis": function () {
      return [];
    },
    "app.statisV2": function () {
      return [];
    },
    "app.perfReport": function () {
      return [];
    },
    "app.getABTestKeys": function () {
      return [""];
    },
    "app.abtestSwitch": function () {
      return [false];
    },
    "app.abtestSwitchV2": function () {
      return [false];
    },
    "app.featuresSwitch": function () {
      return [false];
    },
    "app.getCooperation": function () {
      return [""];
    },
    "app.getDefaultMusicPlayPath": function () {
      return [""];
    },
    "app.getP2PUrl": function () {
      return [""];
    },
    "app.initUrls": function () {
      return [];
    },
    "app.onBootFinish": function () {
      return [];
    },
    "app.enableProcessMonitor": function () {
      return [];
    },
    "app.appStartUpEnd": function () {
      return [];
    },
    "app.systemUIHint": function () {
      return [];
    },
    "app.systemVoiceHint": function () {
      return [];
    },
    "app.tipsAuthMicroPhone": function () {
      return [false];
    },
    "app.setCustomInfo": function () {
      return [];
    },
    "app.getAppStartCommandParams": function () {
      return [""];
    },

    /* ---- 窗口/托盘/更新/浏览器内核：Web 端没有，静默吞 ---- */
    "app.exit": function () {
      return [];
    },
    "app.setAutoRun": function () {
      return [];
    },
    "app.cancelAutoRun": function () {
      return [];
    },
    "app.getAutoRunState": function () {
      return [false];
    },
    "app.isRegisterDefaultClient": function () {
      return [false];
    },
    "app.registerDefaultClient": function () {
      return [];
    },
    "app.unRegisterDefaultClient": function () {
      return [];
    },
    "app.sendFeedback": function () {
      return [];
    },
    "app.recognizeMusic": function () {
      return [false];
    },
    "app.stopRecognizeMusic": function () {
      return [];
    },
    "app.createRecognizeShutcut": function () {
      return [];
    },
    "app.feedbackRecognizeMusicResult": function () {
      return [];
    },
    "app.clearRecognizeMusicCache": function () {
      return [];
    },
    "app.chooseColor": function () {
      return [""];
    },
    "app.compress": function () {
      return [null];
    },
    "app.selectSystemDir": function () {
      return [""];
    },
    "app.selectSystemFileAndDir": function () {
      return [""];
    },
    "app.selectSystemFileLimitCount": function () {
      return [""];
    },
    "app.openSaveFileDialog": function () {
      return [""];
    },
    "app.scanMusicFile": function () {
      return [];
    },
    "app.testProxy": function () {
      return [false];
    },
    /**
     * ⚠️ 必须回 truthy。
     *
     * SDK 侧是"直接回调"风格且只看真假：
     *   At.call("app.loadSkinPackets", type, name, extra, cb)
     *   => cb(t); t || reject("[native-rpc] App.loadSkinAssets(...) error.")
     * 而调用方 `i.App.loadSkinAssets(a)` **不 await 也不 catch**，
     * 所以回 `[]`（= 回调 0 个参数 = undefined）立刻变成一条
     * unhandled rejection。皮肤包我们没法真的解，但"成功"必须答得干脆。
     */
    "app.loadSkinPackets": function () {
      return [true];
    },

    "update.getVersion": function () {
      return ["patch-pc-1"];
    },
    "update.getVisualVersion": function () {
      return ["patch-pc-1"];
    },
    "update.getDownloadVersion": function () {
      return ["patch-pc-1"];
    },
    "update.getCachedInstallPackageVersion": function () {
      return [""];
    },
    "update.checkPatchUpdate": function () {
      return [false];
    },
    "update.startUpdate": function () {
      return [];
    },
    "update.setUpdateState": function () {
      return [];
    },

    /* ---- 窗口：原生窗口系统 → 页内浮层 iframe ---- */

    /**
     * ⚠️ 登录能不能用全看这条。
     * 签名：`winhelper.launchWindow(url, {width,height,x,y}, options)`
     * 返回什么都不重要（前端不读），但**窗口必须真的打开**。
     */
    "winhelper.launchWindow": function (url, pos, opts) {
      openSubWindow(url, pos, opts);
      return [];
    },
    /** 子窗口走到 `/leavePage/true` 时调；iframe 里没有窗口可毁，通知父页收浮层 */
    "winhelper.destroyWindow": function () {
      try {
        if (W.parent && W.parent !== W) W.parent.postMessage({ __nasnem: "closeWindow" }, "*");
        else destroySubWindow(true);
      } catch (e) {
        /* ignore */
      }
      return [];
    },
    /** app/modalOpen 用它把登录窗摆到主窗口正中；网页里给视口尺寸即可 */
    "winhelper.getWindowPosition": function () {
      return [
        {
          x: 0,
          y: 0,
          width: W.innerWidth || 1024,
          height: W.innerHeight || 768,
        },
      ];
    },
    "winhelper.closeWindow": function () {
      return localHandlers["winhelper.destroyWindow"]();
    },
    "winhelper.bringWindowToTop": function () {
      return [];
    },
    "winhelper.showWindow": function () {
      return [];
    },
    "winhelper.setNativeWindowShow": function () {
      return [];
    },
    "winhelper.setWindowTitle": function (t) {
      if (typeof t === "string" && t) {
        try {
          document.title = t;
        } catch (e) {
          /* ignore */
        }
      }
      return [];
    },
    "winhelper.setWindowSizeLimit": function () {
      return [];
    },
    "winhelper.setWindowPosition": function () {
      return [];
    },
    "winhelper.setWindowIconFromLocalFile": function () {
      return [];
    },
    "winhelper.sizeWindow": function () {
      return [];
    },
    "winhelper.minimize": function () {
      return [];
    },
    "winhelper.setWindowFullScreen": function () {
      return [];
    },
    "winhelper.isWindowFullScreen": function () {
      return [false];
    },
    "winhelper.initMainWindow": function () {
      return [];
    },
    "winhelper.finishLoadMainWindow": function () {
      return [];
    },
    "winhelper.dragWindow": function () {
      return [];
    },
    "winhelper.registerHotkey": function () {
      return [];
    },
    "winhelper.unregisterHotkey": function () {
      return [];
    },
    "winhelper.popupMenu": function () {
      return [];
    },
    "winhelper.updateMenu": function () {
      return [];
    },
    "winhelper.setClipBoardData": function () {
      return [];
    },
    "winhelper.getClipBoardData": function () {
      return [""];
    },

    "window.offline": function () {
      return [];
    },
    "window.online": function () {
      return [];
    },

    "cooper360.canInstallBrowser": function () {
      return [false];
    },
    "cooper360.checkBrowserChannel": function () {
      return [false];
    },
    "cooper360.installBrowser": function () {
      return [];
    },
    "cooper360.installBrowserCore": function () {
      return [];
    },
    "cooper360.launchBrowser": function () {
      return [];
    },

    /* ---- 原生下载器：改成浏览器下载 ---- */
    "download.start": function (opts) {
      try {
        var o = typeof opts === "string" ? JSON.parse(opts) : opts || {};
        var u = toLocal(o.url || o.path || "");
        if (u) {
          var a = document.createElement("a");
          a.href = u;
          a.download = o.name || "";
          a.rel = "noopener";
          (document.body || document.documentElement).appendChild(a);
          a.click();
          a.remove();
        }
      } catch (e) {
        /* ignore */
      }
      return [0, 0];
    },
    "download.pause": function () {
      return [];
    },
    "download.cancel": function () {
      return [];
    },
    "download.queryDownloadShecdule": function () {
      return ["[]"];
    },
  };

  /* 本地处理的命令前缀：这些命名空间在浏览器里没有宿主可问，一律本地答 */
  var LOCAL_PREFIXES = ["player.", "audioplayer.", "update.", "window.", "cooper360.", "desktop.", "tray.", "winhelper."];

  state.hasLocal = function (cmd) {
    if (Object.prototype.hasOwnProperty.call(localHandlers, cmd)) return true;
    for (var i = 0; i < LOCAL_PREFIXES.length; i++) {
      if (cmd.slice(0, LOCAL_PREFIXES[i].length) === LOCAL_PREFIXES[i]) return true;
    }
    return false;
  };

  /** 本地事件派发（供本地 handler / 原生 JS 用） */
  state.emitLocal = function (name, args) {
    var list = state.listeners.get(name);
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try {
        list[i].apply(null, args || []);
      } catch (e) {
        /* ignore */
      }
    }
  };

  /* ─────────────────────── window.channel ─────────────────────── */

  function send(msg) {
    var ws = state.ws;
    if (!ws || ws.readyState !== 1) {
      state.queue.push(msg);
      return;
    }
    ws.send(JSON.stringify(msg));
  }

  function flush() {
    var ws = state.ws;
    if (!ws || ws.readyState !== 1) return;
    var q = state.queue;
    state.queue = [];
    for (var i = 0; i < q.length; i++) ws.send(JSON.stringify(q[i]));
  }

  /** 调服务端：返回参数数组（回调参数） */
  function remoteCall(cmd, args) {
    return new Promise(function (resolve, reject) {
      var id = ++state.seq;
      state.pending.set(id, { resolve: resolve, reject: reject });
      send({ id: id, type: "call", cmd: cmd, args: args || [] });
    });
  }

  var channel = {
    /**
     * 官方契约：window.channel.call(cmd, callback, params)
     * callback 以 **展开的参数** 调用（0 个参数时无参调用）。
     */
    call: function (cmd, callback, params) {
      var args = params === undefined || params === null ? [] : params;
      if (!Array.isArray(args)) args = [args];

      // 本地命令：同步/微任务内回掉，行为与原生一致
      if (state.hasLocal(cmd)) {
        var h = localHandlers[cmd];
        Promise.resolve()
          .then(function () {
            return h ? h.apply(null, args) : [];
          })
          .catch(function () {
            return [];
          })
          .then(function (res) {
            if (typeof callback === "function") {
              callback.apply(null, Array.isArray(res) ? res : res === undefined ? [] : [res]);
            }
          });
        return;
      }

      remoteCall(cmd, args).then(
        function (res) {
          if (typeof callback === "function") callback.apply(null, res);
        },
        function (err) {
          // 与原生一致：出错也要回调，避免前端 Promise 永久 pending
          if (typeof callback === "function") callback.apply(null, []);
          if (W.console) console.warn("[nasnem] call failed:", cmd, err && err.message);
        }
      );
    },

    /** 官方契约：window.channel.registerCall(eventName, fn) —— 宿主推送 */
    registerCall: function (name, fn) {
      if (typeof fn !== "function") return;
      var list = state.listeners.get(name);
      if (!list) state.listeners.set(name, (list = []));
      if (list.indexOf(fn) < 0) list.push(fn);
      send({ type: "listen", name: name });
    },

    /** 前端探测用：只要存在就说明"跑在宿主里"，走 Bridge.call 而不是调试 socket */
    viewCall: function () {
      return undefined;
    },

    /* ---- 序列化 / 加密辅助：转发给服务端（纯 JS 实现） ---- */
    enData: function (d) {
      return remoteCall("__enc.enData", [d]).then(function (r) {
        return r[0];
      });
    },
    deData: function (d) {
      return remoteCall("__enc.deData", [d]).then(function (r) {
        return r[0];
      });
    },
    serialData: function (d) {
      return remoteCall("__enc.serialData", [d]).then(function (r) {
        return r[0];
      });
    },
    deSerialData: function (d) {
      return remoteCall("__enc.deSerialData", [d]).then(function (r) {
        return r[0];
      });
    },
    serialKey: function (d) {
      return remoteCall("__enc.serialKey", [d]).then(function (r) {
        return r[0];
      });
    },
    encodeAnonymousId: function (d) {
      return remoteCall("__enc.encodeAnonymousId", [d]).then(function (r) {
        return r[0];
      });
    },
  };

  W.channel = channel;

  /* ─────────────────────── WebSocket 连接 ─────────────────────── */

  var proto = W.location.protocol === "https:" ? "wss:" : "ws:";
  var url = proto + "//" + W.location.host + "/__bridge";

  function connect() {
    var ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setTimeout(connect, 2000);
      return;
    }
    state.ws = ws;

    ws.onopen = function () {
      flush();
      // 重连后把已注册的监听补报一次
      state.listeners.forEach(function (_, name) {
        ws.send(JSON.stringify({ type: "listen", name: name }));
      });
      state.emitLocal("app.onBridgeReady", []);
    };

    ws.onmessage = function (ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.type === "result") {
        var p = state.pending.get(msg.id);
        if (p) {
          state.pending.delete(msg.id);
          p.resolve(msg.data || []);
        }
      } else if (msg.type === "error") {
        var p2 = state.pending.get(msg.id);
        if (p2) {
          state.pending.delete(msg.id);
          p2.reject(new Error(msg.message || "bridge error"));
        }
      } else if (msg.type === "event") {
        state.emitLocal(msg.name, msg.args || []);
      }
    };

    ws.onclose = function () {
      state.ws = null;
      setTimeout(connect, 1500);
    };
    ws.onerror = function () {
      try {
        ws.close();
      } catch (e) {
        /* ignore */
      }
    };
  }

  connect();

  /* 浏览器在线/离线 → 事件（官方是靠原生推的） */
  W.addEventListener("online", function () {
    state.emitLocal("app.netstatus.onLine", []);
  });
  W.addEventListener("offline", function () {
    state.emitLocal("app.netstatus.offLine", []);
  });

  state.startTime = W._enterAppTime || Date.now();
})();

/* ── 游客提示：刷新不出音乐时，先登录即可 ─────────────────────────
 * 官方前端游客态下部分区块（每日推荐等）不出数据；新设备首次打开容易
 * 误以为"没网"。检测到未登录标记就弹一次小提示，8 秒自动消失。 */
(function () {
  var KEY = "__nasnem_login_tip_shown";
  function showTip() {
    try { if (sessionStorage.getItem(KEY)) return; } catch (e) {}
    var d = document.createElement("div");
    d.textContent = "刷新不出音乐？先登录即可刷新";
    d.style.cssText = [
      "position:fixed", "right:20px", "bottom:28px", "z-index:99999",
      "background:#C20C0C", "color:#fff", "font-size:13px", "line-height:1",
      "padding:10px 16px", "border-radius:20px", "box-shadow:0 4px 14px rgba(0,0,0,.25)",
      "opacity:0", "transition:opacity .4s", "pointer-events:none", "font-family:inherit"
    ].join(";");
    document.body.appendChild(d);
    requestAnimationFrame(function () { d.style.opacity = "1"; });
    setTimeout(function () {
      d.style.opacity = "0";
      setTimeout(function () { d.remove(); }, 500);
    }, 8000);
    try { sessionStorage.setItem(KEY, "1"); } catch (e) {}
  }
  function check() {
    var unlogin = document.querySelector('[class*="Unlogin"], [class*="unlogin"]');
    if (unlogin) showTip();
  }
  if (document.readyState === "complete") setTimeout(check, 25000);
  else window.addEventListener("load", function () { setTimeout(check, 25000); });
})();

/* ── 首屏启动画面：弱网下不再白屏 ─────────────────────────────────
 * 主窗口的首屏要拉 12MB+ 的官方 bundle（即使有 gzip，弱网也要十几秒），
 * 之前这段时间是纯白屏，用户以为"打不开"。shim 是页面上最早执行的
 * 脚本之一，在这里同步铺一块启动画面（红圈 spinner + 状态文案）：
 *   - window load 后 600ms 淡出（bundle 已执行、首帧已渲染）；
 *   - 15s 仍在加载则换提示文案（告诉用户弱网首次加载可能 1~2 分钟）；
 *   - 90s 兜底强制淡出，避免极端情况下画面卡死。
 * 只在主窗口（app.html / index.html）生效；子窗口（登录浮层）有
 * 白底容器垫着，不铺。 */
(function () {
  if (!W.__NASNEM_IS_MAIN__) return;
  if (W.__NASNEM_SPLASH__) return;
  W.__NASNEM_SPLASH__ = true;
  try {
    var host = document.body || document.documentElement;
    if (!host) return;

    var style = document.createElement("style");
    style.textContent =
      "@keyframes __nasnem_spin{to{transform:rotate(360deg)}}" +
      "@media (prefers-color-scheme:dark){#__nasnem_splash{background:#1a1a1a!important}" +
      "#__nasnem_splash .ntitle{color:#fff!important}}" ;
    (document.head || document.documentElement).appendChild(style);

    var d = document.createElement("div");
    d.id = "__nasnem_splash";
    d.style.cssText = [
      "position:fixed", "left:0", "top:0", "right:0", "bottom:0",
      "z-index:2147483001", "background:#fff",
      "display:flex", "flex-direction:column", "align-items:center", "justify-content:center",
      "transition:opacity .45s", "font-family:system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif"
    ].join(";");

    var ring = document.createElement("div");
    ring.style.cssText =
      "width:44px;height:44px;border-radius:50%;" +
      "border:4px solid #f3dcdc;border-top-color:#C20C0C;" +
      "animation:__nasnem_spin .9s linear infinite";

    var title = document.createElement("div");
    title.className = "ntitle";
    title.textContent = "网易云音乐";
    title.style.cssText =
      "margin-top:16px;font-size:15px;color:#333;letter-spacing:1px";

    var tip = document.createElement("div");
    tip.textContent = "正在加载…";
    tip.style.cssText = "margin-top:8px;font-size:12px;color:#999";

    d.appendChild(ring);
    d.appendChild(title);
    d.appendChild(tip);
    host.appendChild(d);

    var gone = false;
    function hide() {
      if (gone) return;
      gone = true;
      d.style.opacity = "0";
      setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 500);
    }
    W.addEventListener("load", function () { setTimeout(hide, 600); });
    setTimeout(function () {
      tip.textContent = "网络较慢，仍在加载…首次加载可能需要 1~2 分钟";
    }, 15000);
    setTimeout(hide, 90000);
  } catch (e) { /* 启动画面失败也不能影响官方前端 */
  }
})();
