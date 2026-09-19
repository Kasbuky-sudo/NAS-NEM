/**
 * 运行时依赖解析（飞牛 fnOS 场景）
 * ==============================
 * 本应用在飞牛上**以原生 Node.js 运行**，不依赖 Docker：
 *
 *   Node 二进制   从应用中心的 Node.js v22 应用借（`nodejs_v22`，
 *                 manifest 里用 `install_dep_apps` 声明，安装时自动带上）；
 *   纯 JS 依赖   随本包分发在 `<应用目录>/node_modules`，
 *                 但**优先复用** nodejs_v22 自己带的那一份（见下）。
 *
 * ── 为什么优先复用 nodejs_v22 的 node_modules ──
 * fnpack 打 app.tgz 时会把文件权限拍平（实测所有文件 0666、目录 0777）。
 * 纯 JS 依赖因此照样能 `require` 到，唯一会失效的是 bin 入口的可执行位 ——
 * 而我们运行期并不调用任何 bin，所以这条风险实际不影响启动。
 * 但既然应用中心已经装好了 Node.js v22，它的 `node_modules` 里通常也就有
 * express / ws / tough-cookie（它本身要跑 npm / 各种工具），能借就借，
 * 省掉包内那份冗余；借不到时自动回落到包内的 `node_modules`。
 *
 * ── 做法 ──
 * 在**动态 import 依赖之前**调一次 `installRuntimeResolution()`，
 * 往 `Module.globalPaths` 前面塞候选目录。`globalPaths` 是 CommonJS
 * 解析 `node_modules` 时的兜底搜索路径，Node 官方的 `NODE_PATH` 就是往它里面
 * 塞目录，所以这个做法与 `NODE_PATH=<dirs>` 等价，但不必依赖启动脚本
 * 正确地把环境变量透传进来（`runuser` 会清环境，很容易踩坑）。
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const module_ = require_("node:module");

const HERE = dirname(fileURLToPath(import.meta.url));
/** 应用目录（<app>/src/node-runtime.js → <app>） */
export const APP_DIR = resolve(HERE, "..");

/** 运行期必需的三个依赖，用来判断某个 node_modules 能不能直接用 */
const REQUIRED = ["express", "ws", "tough-cookie"];

function hasAllDeps(dir) {
  return REQUIRED.every((name) => existsSync(resolve(dir, name, "package.json")));
}

/**
 * 候选 `node_modules` 目录，按优先级：
 *   1. 应用自带的 <app>/node_modules   ← 最可控，包内一定有
 *   2. nodejs_v22 应用自带的           ← 复用它省掉冗余
 *   3. 常见系统位置                    ← 兜底
 * @returns {string[]} 实际存在且依赖齐全的目录
 */
export function candidateModuleDirs() {
  const cands = [
    resolve(APP_DIR, "node_modules"),
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
  ];
  // 当前 node 运行时自带的 node_modules：从 execPath 推导
  // （…/nodejs_v22/bin/node → …/nodejs_v22/lib|node_modules），
  // 天然跟随实际安装位置 —— 应用/依赖装在哪个存储空间都对。
  try {
    const rt = dirname(dirname(process.execPath));
    cands.push(resolve(rt, "lib", "node_modules"), resolve(rt, "node_modules"));
  } catch {
    /* ignore */
  }
  // 飞牛上 nodejs_v22 的实际落地位置随卷与目录名变化：扫所有卷的 @appcenter 兜底
  // （2026-09-19 修复：旧逻辑只扫 /vol1，用户装到存储空间2 就找不到）。
  try {
    const { readdirSync } = require_("node:fs");
    const appcenters = [];
    for (const entry of readdirSync("/")) {
      if (/^vol\d+$/.test(entry)) appcenters.push(`/${entry}/@appcenter`);
    }
    for (const ac of appcenters) {
      let names;
      try {
        names = readdirSync(ac);
      } catch {
        continue; // 该卷没有 @appcenter 或不可读，跳过
      }
      for (const v of names) {
        if (/^nodejs_v\d+/.test(v)) {
          cands.push(`${ac}/${v}/lib/node_modules`);
          cands.push(`${ac}/${v}/node_modules`);
        }
      }
    }
  } catch {
    /* 目录不存在就算了 */
  }
  return cands.filter((d) => existsSync(d) && hasAllDeps(d));
}

let installed = false;

/**
 * 把候选目录挂进模块解析路径。可重复调用，幂等。
 * @returns {{used: string[], missing: string[]}}
 */
export function installRuntimeResolution() {
  const dirs = candidateModuleDirs();
  const used = [];

  if (dirs.length) {
    const gp = module_.globalPaths;
    // 倒序 unshift，保证 dirs[0] 排在最前（优先级最高）
    for (const d of dirs.slice().reverse()) {
      if (!gp.includes(d)) {
        gp.unshift(d);
        used.push(d);
      }
    }
  }

  // 单个依赖缺失时单独开个口子兜底（比如只差 tough-cookie）
  const missing = REQUIRED.filter((name) => {
    try {
      require_.resolve(name);
      return false;
    } catch {
      return true;
    }
  });

  installed = true;
  return { used, missing };
}

export function isInstalled() {
  return installed;
}

export default { APP_DIR, installRuntimeResolution, candidateModuleDirs, isInstalled };
