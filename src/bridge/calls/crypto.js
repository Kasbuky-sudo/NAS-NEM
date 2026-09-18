/**
 * __enc.* —— 前端原生加密原语的服务端实现
 * ========================================
 * 对应 `window.channel.{serialData,deSerialData,serialKey,enData,deData,encodeAnonymousId}`。
 * 详见 src/crypto/eapi.js 里的算法说明与风险标注。
 *
 * 已实测对齐官方的两条（`npm run probe:eapi`）：
 *   - serialData  : 固定 key `e82ckenh8dichen8` + **hex**
 *   - deSerialData: 同一个 key 解裸密文响应
 * 剩下 `enData/deData`（cache_key 用）仍是自洽实现，不影响接口可用性。
 */
import * as enc from "../../crypto/eapi.js";
import createLogger from "../../logger.js";

const log = createLogger("crypto");

let deSerialWarned = false;

export function makeCryptoCalls() {
  return {
    /**
     * 前端签名：`EncryptData.serialData([url, jsonText])` → eapi params
     * （形如 `z = (url, data, header) => serialData([url, JSON.stringify({...data, header})])`）
     */
    "__enc.serialData": (arg) => {
      const [url, text] = Array.isArray(arg) ? arg : [arg, ""];
      if (!url) return [""];
      return [enc.eapiParams(String(url), String(text ?? ""))];
    },
    /**
     * eapi 响应解密。前端递进来的是**字符串**（base64 或 latin1 二进制串），
     * 见 eapi.js 里 eapiDecryptResponse 的说明。
     *
     * 解不开时**不能**静默返回 "{}" —— 前端会 `JSON.parse` 它，然后理直气壮地
     * 显示"没有数据"，把加密层的错误伪装成业务空数据。所以这里必须留日志。
     */
    "__enc.deSerialData": (arg) => {
      const out = enc.eapiDecryptResponse(arg);
      if (out) return [out];
      if (!deSerialWarned) {
        deSerialWarned = true;
        const preview = typeof arg === "string" ? arg.slice(0, 120) : Buffer.isBuffer(arg) ? arg.subarray(0, 48).toString("hex") : String(arg).slice(0, 120);
        log.warn(
          `eapi 响应解密失败，前端将拿到空对象。原始输入长度=${typeof arg === "string" ? arg.length : "<非字符串>"} 前缀=${preview}`
        );
      }
      return ["{}"];
    },
    "__enc.serialKey": (arg) => [enc.serialKey(arg)],
    "__enc.enData": (arg) => [enc.enData(arg)],
    "__enc.deData": (arg) => [enc.deData(arg)],
    "__enc.encodeAnonymousId": (arg) => [enc.encodeAnonymousId(arg)],

    /* 兼容裸命令名（老 SDK 的 do("serialKey")） */
    serialKey: (arg) => [enc.serialKey(arg)],
    serialData: (arg) => {
      const [url, text] = Array.isArray(arg) ? arg : [arg, ""];
      return [enc.eapiParams(String(url), String(text ?? ""))];
    },
  };
}

export default makeCryptoCalls;
