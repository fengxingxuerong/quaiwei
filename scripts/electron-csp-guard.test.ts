/**
 * scripts/electron-csp-guard.test.ts —— 桌面版 LLM 通道接线静态守卫（v0.9.58）
 *
 * 守的是两个叠加缺陷，两者都**没有编译错误、只在 Electron 包里现形**：
 *   ① electron-app/index.html 的 CSP `connect-src https:` 把主进程转发服务
 *      http://127.0.0.1:<port> 毙掉（CDP blockedReason=csp）⇒ 桌面端 LLM 全挂；
 *   ② 相对路径 /sensenova/v1 在 file:// 页解析成 file:///...，Chromium 禁止
 *      file:// 页 fetch file:// URL ⇒ 必须经 preload 拿端口后改写。
 * 为什么测试不到：vite 入口是根 index.html（无 CSP），dev/Web 版全绿。
 * 所以这里用静态守卫把四个文件的接线锁死。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ⚠️ 不能用 process.cwd()：本文件可能被 --root 从别的目录调起（vitest 的 cwd 是调用目录），
// 那样 existsSync 全假、报出来的却是「文件不存在」这种完全误导的错误。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const read = (rel: string): string => {
  const abs = path.resolve(ROOT, rel);
  expect(existsSync(abs), `前置：文件必须存在 ${rel}`).toBe(true);
  return readFileSync(abs, "utf8");
};

describe("① CSP 必须放行本机转发服务（scripts/sync-dist.mjs 注入模板）", () => {
  // ⚠️ 断言对象是 sync-dist.mjs 的**注入模板**，不是 electron-app/index.html：
  //    后者是 build 时由前者生成的（.gitignore 第 21 行忽略），会被每次 build 覆盖，
  //    断言它等于断言一个随时会重生的文件。
  const sync = read("scripts/sync-dist.mjs");

  /** 从注入模板的 content="..." 里拆出 connect-src 的 token 数组。
   *  ⚠️ 必须锚定 content=" —— sync-dist.mjs 的注释里也提到了 connect-src，
   *  不锚定会先匹配到注释文本。 */
  function injectedConnectSrc(): string[] {
    const m = sync.match(/content="[^"]*connect-src ([^;"]*)/);
    expect(m, "sync-dist.mjs 里必须有一段注入的 CSP，且含 connect-src").not.toBeNull();
    return m![1].trim().split(/\s+/).filter(Boolean);
  }

  it("connect-src 含 http://127.0.0.1:* 与 http://localhost:*", () => {
    const tokens = injectedConnectSrc();
    expect(tokens).toContain("https:");
    expect(tokens).toContain("http://127.0.0.1:*");
    expect(tokens).toContain("http://localhost:*");
  });

  it("https: 未被移除（自定义 https 网关仍要能直连）", () => {
    expect(injectedConnectSrc()).toContain("https:");
  });

  it("模板确实带 http-equiv=Content-Security-Policy（不是普通 meta）", () => {
    expect(sync).toMatch(/http-equiv="Content-Security-Policy"/);
  });
});

describe("② 端口必须由主进程经 preload 暴露，不能写死", () => {
  const main = read("electron-app/main.js");
  const preload = read("electron-app/preload.js");

  it("main.js 把 listen 成功的端口记进 PROXY_PORT 并注册 proxy-port handler", () => {
    expect(main).toMatch(/let\s+PROXY_PORT\s*=/);
    // ⚠️ 行首锚定 + m 标志：注释掉的 `// registerProxyPort();` 也曾骗过宽松正则
    expect(main).toMatch(/^\s{2}registerProxyPort\(\);/m);
    expect(main).toMatch(/^\s{8}PROXY_PORT\s*=\s*port;/m);
    expect(main).toMatch(/ipcMain\.handle\(\s*["']proxy-port["']/);
  });

  it("preload.js 暴露 window.proxy.port()", () => {
    expect(preload).toMatch(/exposeInMainWorld\(\s*["']proxy["']/);
    expect(preload).toMatch(/["']proxy-port["']/);
  });

  it("registerProxyPort 真的被调用（漏调用 = 渲染层 invoke 报 No handler）", () => {
    expect(main).toMatch(/^\s{2}registerProxyPort\(\);/m);
  });
});

describe("③ 渲染层改写逻辑存在（src/api/desktop-proxy.ts）", () => {
  const src = read("src/api/desktop-proxy.ts");

  it("导出 resolveDesktopBaseUrl，且 llm-chat / detector 都调用它", () => {
    expect(src).toMatch(/export\s+async\s+function\s+resolveDesktopBaseUrl/);
    expect(read("src/api/llm-chat.ts")).toMatch(/resolveDesktopBaseUrl\(cfg\.baseUrl\)/);
    expect(read("src/api/detector.ts")).toMatch(/resolveDesktopBaseUrl\(cfg\.url\)/);
  });

  it("改写的目标地址带 http://127.0.0.1 前缀（与 CSP 放行项对齐）", () => {
    expect(src).toMatch(/http:\/\/127\.0\.0\.1:/);
  });
});
