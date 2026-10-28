/**
 * 一键配置链接（v0.9.81）：把 API 配置编码进启动链接的 hash，双击 bat 即完成配置。
 *
 * 背景：网页版的 LLM 通道要手填三项（网关地址 / API Key / 模型名），是小白
 * 流失率最高的一步。「一键配置API.bat」收集完这三项后，带着 `#api=<编码>` 打开
 * 页面；App 启动时消费这个 hash，走与设置面板相同的 persistApiConfig 落盘
 * （桌面版自动进安全存储），保存后立刻抹掉 hash——凭证不留在地址栏与历史里。
 *
 * 为什么放 hash 不放 query：fragment 浏览器**永远不会发给服务器**（dev 日志、
 * 反代日志都拿不到）；编码用 base64url（无 +/=），过 URLSearchParams 不变形。
 *
 * 这是传输层不是加密层：能打开这个 URL 的人本来就看得见屏幕。真正的防线是
 * 项目一贯的口径——Key 只落本机（Web=localStorage，桌面=safeStorage）。
 */

/** bat 侧允许配置的字段。刻意只收这几项：一键配置要的是「能跑」，微调去设置面板。 */
export interface ApiConfigLink {
  baseUrl: string;
  apiKey: string;
  model: string;
  judgeModel?: string;
  altModel?: string;
}

/** 字段长度上限：正常值远小于此，只为拦「把整篇文档塞进链接」的误用 */
const MAX_URL = 500;
const MAX_KEY = 500;
const MAX_MODEL = 200;

/** 编码成 base64url（UTF-8 安全：先 TextEncoder 再 btoa，中文 Key/模型名不乱码） */
export function encodeApiConfigLink(cfg: ApiConfigLink): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cfg));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array | null {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4 !== 0) t += "=";
  try {
    const bin = atob(t);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null; // 非 base64 字符 / 长度坏：一律当垃圾参数
  }
}

/**
 * 解码并校验。任何一步不合格返回 null，**绝不抛错**也绝不带默认值——
 * 这是外部输入（浏览器地址栏），宁可忽略也不能把猜出来的半份配置写进设置。
 * 校验通过返回白名单字段；没给 judgeModel / altModel 就不带这个键。
 */
export function parseApiConfigLink(raw: string): ApiConfigLink | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 4096) return null;
  const bytes = base64UrlDecode(trimmed);
  if (!bytes) return null;
  let o: unknown;
  try {
    o = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
  const rec = o as Record<string, unknown>;
  const str = (k: string, max: number): string => {
    const v = rec[k];
    return typeof v === "string" ? v.trim().slice(0, max) : "";
  };
  const baseUrl = str("baseUrl", MAX_URL);
  const apiKey = str("apiKey", MAX_KEY);
  const model = str("model", MAX_MODEL);
  // 三项必填；baseUrl 只认 http(s) 绝对地址或同源代理相对路径（/sensenova/v1 这类）
  if (!baseUrl || !apiKey || !model) return null;
  if (!/^(https?:\/\/|\/)/i.test(baseUrl)) return null;
  const out: ApiConfigLink = { baseUrl, apiKey, model };
  const judgeModel = str("judgeModel", MAX_MODEL);
  const altModel = str("altModel", MAX_MODEL);
  if (judgeModel) out.judgeModel = judgeModel;
  if (altModel) out.altModel = altModel;
  return out;
}

/**
 * 从 location.hash 里摘出 `api` 参数的**原始值**（允许与其它参数混排）。
 * 返回 null = 链接里根本没有 api 参数（普通带 hash 的访问，静默忽略）；
 * 返回空串以外的字符串但 parse 失败 = 参数存在但坏了，调用方应提示用户重跑配置。
 */
export function readApiConfigParam(hash: string): string | null {
  if (!hash || hash.charAt(0) !== "#") return null;
  const v = new URLSearchParams(hash.slice(1)).get("api");
  return v === null ? null : v;
}
