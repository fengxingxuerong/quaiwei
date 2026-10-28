// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { encodeApiConfigLink, parseApiConfigLink, readApiConfigParam } from "./api-config-link";

describe("encodeApiConfigLink / parseApiConfigLink 往返", () => {
  it("三项必填字段往返无损", () => {
    const cfg = {
      baseUrl: "https://token.sensenova.cn/v1",
      apiKey: "sk-abc123",
      model: "deepseek-v4-flash",
    };
    expect(parseApiConfigLink(encodeApiConfigLink(cfg))).toEqual(cfg);
  });

  it("中文模型名 / 全角字符不乱码（UTF-8 编码路径）", () => {
    const cfg = { baseUrl: "/sensenova/v1", apiKey: "sk-密钥", model: "混元-中文模型" };
    expect(parseApiConfigLink(encodeApiConfigLink(cfg))).toEqual(cfg);
  });

  it("judgeModel / altModel 给了就带上", () => {
    const cfg = {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-1",
      model: "deepseek/deepseek-chat",
      judgeModel: "glm-5.2",
      altModel: "kimi-k3",
    };
    expect(parseApiConfigLink(encodeApiConfigLink(cfg))).toEqual(cfg);
  });

  it("base64 标准字母表（+/=）混进来也能解——bat 手改链接容错", () => {
    const std = btoa(JSON.stringify({ baseUrl: "https://x.io/v1", apiKey: "k", model: "m" }));
    expect(parseApiConfigLink(std)).toEqual({
      baseUrl: "https://x.io/v1",
      apiKey: "k",
      model: "m",
    });
  });
});

describe("parseApiConfigLink 拒绝坏输入（外部输入，宁忽略不猜）", () => {
  it("非 base64 / 非 JSON / 非对象 / JSON 数组", () => {
    const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
    expect(parseApiConfigLink("")).toBeNull();
    expect(parseApiConfigLink("不是编码!!!")).toBeNull();
    expect(parseApiConfigLink(b64("这就是纯文本"))).toBeNull();
    expect(parseApiConfigLink(b64("[1,2]"))).toBeNull();
    expect(parseApiConfigLink(b64("null"))).toBeNull();
  });

  it("缺任一必填字段 → null（不许带默认值写出半份配置）", () => {
    expect(
      parseApiConfigLink(encodeApiConfigLink({ baseUrl: "", apiKey: "k", model: "m" })),
    ).toBeNull();
    expect(
      parseApiConfigLink(encodeApiConfigLink({ baseUrl: "https://x.io", apiKey: "", model: "m" })),
    ).toBeNull();
    expect(
      parseApiConfigLink(encodeApiConfigLink({ baseUrl: "https://x.io", apiKey: "k", model: "" })),
    ).toBeNull();
  });

  it("baseUrl 协议白名单：javascript:/data:/纯主机名一律拒", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "ftp://x.io/v1",
      "token.sensenova.cn/v1",
    ]) {
      const enc = encodeApiConfigLink({ baseUrl: bad, apiKey: "k", model: "m" });
      expect(parseApiConfigLink(enc)).toBeNull();
    }
  });

  it("字段类型不对（数字/对象冒充字符串）→ null", () => {
    const enc = btoa(JSON.stringify({ baseUrl: "https://x.io", apiKey: 123, model: "m" }));
    expect(parseApiConfigLink(enc)).toBeNull();
  });

  it("超长输入直接拒（不进解码）", () => {
    expect(parseApiConfigLink("a".repeat(5000))).toBeNull();
  });
});

describe("readApiConfigParam：从 hash 摘参数", () => {
  const enc = encodeApiConfigLink({ baseUrl: "https://x.io/v1", apiKey: "k", model: "m" });

  it("#api=xxx 命中；与其它参数混排也命中", () => {
    expect(readApiConfigParam(`#api=${enc}`)).toBe(enc);
    expect(readApiConfigParam(`#foo=1&api=${enc}&bar=2`)).toBe(enc);
  });

  it("没有 hash / 没有api参数 → null（普通访问静默忽略）", () => {
    expect(readApiConfigParam("")).toBeNull();
    expect(readApiConfigParam("#foo=1")).toBeNull();
    expect(readApiConfigParam("api=xxx")).toBeNull();
  });

  it("参数存在但为空串 → 返回空串（区分「没有」与「坏了」，App 据此提示）", () => {
    expect(readApiConfigParam("#api=")).toBe("");
  });

  it("端到端：readApiConfigParam + parseApiConfigLink 组合可用", () => {
    expect(parseApiConfigLink(readApiConfigParam(`#api=${enc}`) ?? "")).toEqual({
      baseUrl: "https://x.io/v1",
      apiKey: "k",
      model: "m",
    });
  });
});
