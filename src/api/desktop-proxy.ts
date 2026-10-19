/**
 * 桌面版 LLM 通道解析：把「/sensenova」相对路径改写成本机转发服务的绝对地址。
 *
 * 背景（v0.9.58 修的两个叠加缺陷，都只在 Electron 包里现形）：
 *   ① `electron-app/index.html` 的 CSP 原为 `connect-src https:`，
 *      把主进程转发服务 `http://127.0.0.1:<port>` 一并挡死
 *      （CDP `Network.loadingFailed.blockedReason === "csp"`）；
 *   ② 设置面板与 SENSENOVA_PRESET 把 Base URL 填成**相对路径** `/sensenova/v1`，
 *      而 file:// 页面会把它解析成 `file:///sensenova/v1/...` ——
 *      Chromium 禁止 file:// 页 fetch file:// URL（同目录普通文件同样取不到），
 *      main.js 里对 `file:///sensenova/*` 的 webRequest 重写因此永远等不到请求。
 * 本模块负责②：经 preload 桥拿主进程的真实端口，拼出绝对地址。
 * dev 由 vite proxy 接管、Web 版没有 window.proxy ⇒ 原样返回，行为不变。
 */

declare global {
  interface Window {
    /** 桌面版 preload 暴露的本机转发服务查询桥；Web 版不存在。 */
    proxy?: {
      port?: () => number | null | Promise<number | null>;
    };
  }
}

/** 只认「/sensenova」或「/sensenova/...」开头的相对路径（带首尾空白也认）。 */
export function isSenseNovaRelativePath(baseUrl: string): boolean {
  return /^\/sensenova(?=\/|$)/.test(baseUrl.trim());
}

/** 本机转发服务端口；拿不到（Web / dev / 服务未起）返回 null。 */
export async function desktopProxyPort(): Promise<number | null> {
  if (typeof window === "undefined") return null;
  const fn = window.proxy?.port;
  if (typeof fn !== "function") return null;
  try {
    const v = await fn();
    return typeof v === "number" && v > 0 ? v : null;
  } catch {
    // 桥坏/主进程没起服务：静默回退，让调用方按原值走
    return null;
  }
}

/**
 * `/sensenova/v1` → `http://127.0.0.1:<port>/v1`
 *
 * 剥掉 `/sensenova` 前缀是因为转发服务自己也剥（`main.js` 的
 * `pathname.replace(/^\/sensenova(?=\/|$)/, "")`），两种写法都通；
 * 这里统一发不带前缀的规范路径。
 *
 * 非相对路径、或取不到端口时**原样返回**——dev 的 vite proxy 与
 * Web 版的自备反代都依赖原值，不能在这里改。
 */
export async function resolveDesktopBaseUrl(baseUrl: string): Promise<string> {
  if (!isSenseNovaRelativePath(baseUrl)) return baseUrl;
  const port = await desktopProxyPort();
  if (port === null) return baseUrl;
  const rest = baseUrl
    .trim()
    .replace(/^\/sensenova(?=\/|$)/, "")
    .replace(/^\/+/, "");
  return rest ? `http://127.0.0.1:${port}/${rest}` : `http://127.0.0.1:${port}`;
}
