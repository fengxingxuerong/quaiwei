/**
 * @vitest-environment happy-dom
 *
 * src/api/desktop-proxy.test.ts —— 「/sensenova」相对路径 → 本机转发服务绝对地址
 *
 * 守的是 v0.9.58 修的两个叠加缺陷之一：桌面版把 Base URL 填成 /sensenova/v1 时，
 * file:// 页面会解析成 file:///sensenova/v1/...，而 Chromium 禁止 file:// 页
 * fetch file:// URL ⇒ 必须改写成 http://127.0.0.1:<port>/v1。
 * 端口由主进程经 preload 桥给出（被占会自动 +1），不能写死。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isSenseNovaRelativePath, desktopProxyPort, resolveDesktopBaseUrl } from "./desktop-proxy";
import { chat } from "./llm-chat";
import type { ApiConfig } from "./llm-config";

type Bridge = { port?: () => number | null | Promise<number | null> };
const w = window as unknown as { proxy?: Bridge };

beforeEach(() => {
  delete w.proxy;
});
afterEach(() => {
  delete w.proxy;
});

describe("isSenseNovaRelativePath：只认整段 /sensenova 前缀", () => {
  it("/sensenova 与 /sensenova/... 都算", () => {
    expect(isSenseNovaRelativePath("/sensenova/v1")).toBe(true);
    expect(isSenseNovaRelativePath("/sensenova")).toBe(true);
    expect(isSenseNovaRelativePath("  /sensenova/v1  ")).toBe(true);
  });

  it("前缀必须整段匹配：/sensenovax、缺前导斜杠、绝对地址都不算", () => {
    expect(isSenseNovaRelativePath("/sensenovax/v1")).toBe(false);
    expect(isSenseNovaRelativePath("sensenova/v1")).toBe(false);
    expect(isSenseNovaRelativePath("https://api.deepseek.com/v1")).toBe(false);
    expect(isSenseNovaRelativePath("https://api.openai.com/v1")).toBe(false);
    expect(isSenseNovaRelativePath("")).toBe(false);
  });
});

describe("desktopProxyPort：桥的三态", () => {
  it("无桥（Web 版）→ null", async () => {
    expect(await desktopProxyPort()).toBeNull();
  });

  it("有桥 → 照实返回端口（含被占后 +1 的情况）", async () => {
    w.proxy = { port: () => 18964 };
    expect(await desktopProxyPort()).toBe(18964);
    w.proxy = { port: async () => 18974 };
    expect(await desktopProxyPort()).toBe(18974);
  });

  it("桥抛异常或返回非正数 → 静默回退 null（不崩主流程）", async () => {
    w.proxy = {
      port: () => {
        throw new Error("no handler registered");
      },
    };
    expect(await desktopProxyPort()).toBeNull();
    w.proxy = { port: () => 0 };
    expect(await desktopProxyPort()).toBeNull();
    w.proxy = { port: () => null };
    expect(await desktopProxyPort()).toBeNull();
  });
});

describe("resolveDesktopBaseUrl", () => {
  it("桌面版：/sensenova/v1 → http://127.0.0.1:<port>/v1", async () => {
    w.proxy = { port: () => 18964 };
    expect(await resolveDesktopBaseUrl("/sensenova/v1")).toBe("http://127.0.0.1:18964/v1");
  });

  it("端口被占（18974）时用真实端口，不写死 18964", async () => {
    w.proxy = { port: () => 18974 };
    expect(await resolveDesktopBaseUrl("/sensenova/v1")).toBe("http://127.0.0.1:18974/v1");
  });

  it("裸 /sensenova → 只到根（调用方自己拼 /chat/completions）", async () => {
    w.proxy = { port: () => 18964 };
    expect(await resolveDesktopBaseUrl("/sensenova")).toBe("http://127.0.0.1:18964");
  });

  it("无桥（Web/dev）原样返回：vite proxy 与自备反代都依赖原值", async () => {
    expect(await resolveDesktopBaseUrl("/sensenova/v1")).toBe("/sensenova/v1");
    expect(await resolveDesktopBaseUrl("/sensenova")).toBe("/sensenova");
  });

  it("绝对地址一律不动（含自定义 https 网关）", async () => {
    w.proxy = { port: () => 18964 };
    for (const u of [
      "https://api.deepseek.com/v1",
      "https://api.openai.com/v1",
      "https://open.bigmodel.cn/api/paas/v4",
      "http://127.0.0.1:18964/v1",
    ]) {
      expect(await resolveDesktopBaseUrl(u)).toBe(u);
    }
  });
});

describe("端到端：chat() 用改写后的绝对地址发请求", () => {
  const cfg: ApiConfig = {
    enabled: true,
    baseUrl: "/sensenova/v1",
    apiKey: "k1",
    apiKeys: "",
    model: "deepseek-v4-flash",
    temperature: 0.7,
    deepMode: false,
    judgeModel: "",
    altModel: "",
    style: "plain",
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("桌面版：fetch 的 URL 是 http://127.0.0.1:<port>/v1/chat/completions，不是 file:///", async () => {
    w.proxy = { port: () => 18964 };
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        return new Response(JSON.stringify({ choices: [{ message: { content: "正常" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const r = await chat(cfg, [{ role: "user", content: "hi" }], {
      temperature: 0.7,
      maxTokens: 50,
    });
    expect(r.content).toBe("正常");
    expect(seen).toEqual(["http://127.0.0.1:18964/v1/chat/completions"]);
    expect(seen[0].startsWith("file:")).toBe(false);
  });

  it("无桥（Web 版）：URL 保持相对路径，由 vite proxy / 自备反代接管", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    await chat(cfg, [{ role: "user", content: "hi" }], { temperature: 0.7, maxTokens: 50 });
    expect(seen).toEqual(["/sensenova/v1/chat/completions"]);
  });
});
