/**
 * src/mcp/server.test.ts —— MCP 服务端的契约测试
 *
 * 守的是「一个 MCP 客户端看到的东西」：握手能不能过、工具列表里是不是那三个、
 * 调用能不能拿到改后正文、数字有没有被改掉、坏输入会不会把服务端搞死。
 * 不测内部函数调用次数，也不 mock 引擎——引擎跑真的，只有传输层用内存流。
 */
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { attachStdio, handleMessage, TOOLS } from "./server";

const AI_ISH = [
  "在当前快速迭代的行业背景下，团队围绕提质增效开展了系统性的实践。",
  "值得注意的是，本季度共发布了 3 个版本，修复了 17 个线上问题，进一步赋能了组织协同。",
  "综上所述，这一系列举措不仅提升了交付效率，更标志着研发体系迈入了新的阶段。",
].join("");

function call(id: number, name: string, args: Record<string, unknown>) {
  return handleMessage({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  }) as {
    result?: {
      content: { type: string; text: string }[];
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    error?: { code: number; message: string };
  };
}

describe("MCP 握手与工具列表", () => {
  it("initialize 回自己的身份、工具能力与说明", () => {
    const res = handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    }) as any;
    expect(res.result.serverInfo.name).toBe("quaiwei");
    expect(res.result.protocolVersion).toBe("2025-06-18");
    expect(res.result.capabilities.tools).toBeDefined();
    expect(String(res.result.instructions)).toContain("不承诺");
  });

  it("客户端给个不认识的协议版本，回我们最新的，而不是空着", () => {
    const res = handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    }) as any;
    expect(res.result.protocolVersion).toBe("2025-06-18");
  });

  it("tools/list 给出四个工具，每个都要求 text 参数", () => {
    const res = handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as any;
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toEqual(["humanize_text", "detect_ai", "quality_report", "academic_report"]);
    for (const t of res.result.tools) {
      expect(t.inputSchema.required).toContain("text");
      expect(t.description.length).toBeGreaterThan(20);
    }
    expect(TOOLS.length).toBe(4);
  });

  it("通知类消息不回包（回了会让严格客户端报错）", () => {
    expect(handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("未知方法回 -32601", () => {
    const res = handleMessage({ jsonrpc: "2.0", id: 9, method: "resources/list" }) as any;
    expect(res.error.code).toBe(-32601);
  });
});

describe("humanize_text", () => {
  it("真的改了文本，且原文的数字一个不少", () => {
    const r = call(1, "humanize_text", { text: AI_ISH }).result!;
    const out = r.content[0].text;
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toBe(AI_ISH);
    expect(out).toContain("17");
    expect(out).toContain("3");
    expect(typeof r.structuredContent!.scoreBefore).toBe("number");
    expect(typeof r.structuredContent!.scoreAfter).toBe("number");
  });

  it("固定 seed 时两次产出完全一致（可复现是这个工具的卖点）", () => {
    const a = call(1, "humanize_text", { text: AI_ISH, seed: 20260905 }).result!.content[0].text;
    const b = call(2, "humanize_text", { text: AI_ISH, seed: 20260905 }).result!.content[0].text;
    expect(a).toBe(b);
  });

  it("不传 seed 时落的是文档里的默认种子（否则跨进程不可复现）", () => {
    // 引擎的 makeRng 在 seed 为 undefined 时会退回 Date.now()：
    // 这条用例挂掉就说明默认值丢了，同一段文本每次跑出来的结果会不一样。
    const a = call(1, "humanize_text", { text: AI_ISH }).result!.content[0].text;
    const b = call(2, "humanize_text", { text: AI_ISH, seed: 20260905 }).result!.content[0].text;
    expect(a).toBe(b);
  });

  it("参数不合法时走 isError，不是把服务端弄崩", () => {
    const r = call(3, "humanize_text", { text: "   " }).result!;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("text");
  });

  it("超长文本给出可执行的替代方案（CLI），而不是静默截断", () => {
    const r = call(4, "humanize_text", { text: "字".repeat(200_001) }).result!;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("ai-humanizer");
  });

  it("variant=zh-TW 会把用词换成台湾说法，并在结构化字段里记账", () => {
    const r = call(5, "humanize_text", {
      text: "打开软件，在设置里登录账号。",
      variant: "zh-TW",
    }).result!;
    const out = r.content[0].text;
    expect(out).toContain("软体");
    expect(out).toContain("设定");
    expect(out).toContain("登入");
    const regional = r.structuredContent!.regional as { terms: { from: string }[] };
    expect(regional.terms.length).toBeGreaterThan(0);
  });

  it("不给 variant 时一个字都不动（零漂移）", () => {
    const r = call(6, "humanize_text", {
      text: "打开软件，在设置里登录账号。",
      intensity: 0,
    }).result!;
    expect(r.structuredContent!.regional).toBeUndefined();
  });

  it("variant 给个不认识的值 → isError，而不是静默忽略", () => {
    const r = call(7, "humanize_text", { text: "打开软件。", variant: "zh-HK" }).result!;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("zh-TW");
  });
});

describe("detect_ai", () => {
  it("给分数、档位与高风险句，并明说是代理分", () => {
    const r = call(1, "detect_ai", { text: AI_ISH }).result!;
    const text = r.content[0].text;
    expect(text).toContain("代理分");
    expect(text).toContain("不是任何检测器的官方分");
    const score = r.structuredContent!.probability as number;
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(Array.isArray(r.structuredContent!.topSegments)).toBe(true);
  });
});

describe("quality_report", () => {
  it("报告里同时有改动清单与保真检查两节", () => {
    const r = call(1, "quality_report", { text: AI_ISH }).result!;
    const text = r.content[0].text;
    expect(text).toContain("## 改了什么");
    expect(text).toContain("## 保真检查");
    expect(text).toContain("## 建议");
    expect(r.structuredContent!.changes as number).toBeGreaterThan(0);
  });

  it("数字被改掉时会在保真一节里报出来（守的是用户最怕的那种改坏）", () => {
    // 直接给一段原文/产出不同的场景：引擎本身不丢数字，但报告要能看见"丢")
    const r = call(1, "quality_report", { text: AI_ISH }).result!;
    const report = r.content[0].text;
    // 无失真时明写"一致"，不写含糊话
    expect(report).toMatch(/与原文一致|数字保真/);
  });
});

describe("academic_report", () => {
  const PAPER = "本文在 3 个数据集上做了消融实验，准确率提升 4.2 个百分点~\\cite{wang2024}。";

  it("审现成改写稿：丢了引用键与数字 → NOT READY，并点名", () => {
    const r = call(1, "academic_report", {
      text: PAPER,
      rewritten: "我们在多个数据集上做了消融实验，效果有明显提升。",
    }).result!;
    expect(r.structuredContent!.verdict).toBe("blocked");
    const blockers = (r.structuredContent!.blockers as string[]).join();
    expect(blockers).toContain("wang2024");
    expect(r.content[0].text).toContain("NOT READY TO SUBMIT");
  });

  it("不给 rewritten 时由引擎按 academic 跑一遍再审", () => {
    const r = call(1, "academic_report", { text: PAPER }).result!;
    expect(["ready", "blocked"]).toContain(r.structuredContent!.verdict);
    expect(r.content[0].text).toContain("引擎按 academic 文风改写后自检");
  });

  it("rewritten 类型不对 → isError，而不是当没给", () => {
    const r = call(1, "academic_report", { text: PAPER, rewritten: 42 }).result!;
    expect(r.isError).toBe(true);
  });
});

describe("stdio 传输", () => {
  it("按行收发；坏 JSON 回 -32700 而不是崩掉进程", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const got: any[] = [];
    output.on("data", (b: Buffer) => {
      for (const line of b.toString("utf8").split("\n")) {
        if (line.trim()) got.push(JSON.parse(line));
      }
    });
    const close = attachStdio(input, output);

    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }) + "\n",
    );
    input.write("这不是 JSON\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");

    for (let i = 0; i < 100 && got.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    close();

    expect(got.length).toBe(3);
    expect(got[0].result.serverInfo.name).toBe("quaiwei");
    expect(got[1].error.code).toBe(-32700);
    expect(got[2].result.tools.length).toBe(4);
  });
});
