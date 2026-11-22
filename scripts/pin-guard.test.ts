import { describe, it, expect } from "vitest";
import { humanize } from "../src/engine/humanize";
import {
  PIN_OPEN,
  PIN_CLOSE,
  PIN_MIN_CHARS,
  autoStructurePins,
  parsePinFile,
  preparePins,
  restorePins,
  restorePinsWithRetry,
} from "./pin-guard";

describe("parsePinFile", () => {
  it("一行一段；空行/注释/过短跳过，保留行内空格与重复去重", () => {
    const r = parsePinFile(
      [
        "",
        "  ",
        "# 这是注释",
        "短",
        "营收增长了5.6个百分点",
        "营收增长了5.6个百分点",
        " 带 空格 的 片段 ",
      ].join("\n"),
    );
    expect(r.pins).toEqual(["营收增长了5.6个百分点", " 带 空格 的 片段 "]);
    expect(r.skipped).toEqual([{ line: 4, reason: `可见字符 1 < ${PIN_MIN_CHARS}` }]);
  });

  it("空行与注释不计入 skipped，只记过短与超上限", () => {
    const r = parsePinFile(["", "# 注释", "三字短", "正常片段内容"].join("\n"));
    expect(r.pins).toEqual(["正常片段内容"]);
    expect(r.skipped).toEqual([{ line: 3, reason: `可见字符 3 < ${PIN_MIN_CHARS}` }]);
  });

  it("超过 PIN_MAX 的段落被跳过并给原因", () => {
    const lines = Array.from({ length: 70 }, (_, i) => `钉住片段内容${i}`);
    const r = parsePinFile(lines.join("\n"));
    expect(r.pins.length).toBe(64);
    expect(r.skipped.length).toBe(6);
  });
});

describe("preparePins / restorePins", () => {
  it("命中片段换占位符；长片段优先，避免子串抢占", () => {
    const raw = "营收增长了5.6个百分点，这一数据来自公司官方财报。";
    const p = preparePins(raw, ["营收增长", "营收增长了5.6个百分点"]);
    expect(p.pins).toEqual(["营收增长了5.6个百分点"]);
    expect(p.text).not.toContain("营收增长");
    expect(p.text).toBe(`${PIN_OPEN}0${PIN_CLOSE}，这一数据来自公司官方财报。`);
    expect(p.unmatched).toEqual(["营收增长"]);
  });

  it("同一片段多次出现全部替换；还原后逐字出现", () => {
    const raw = "甲：营收5.6个百分点。乙：营收5.6个百分点。";
    const p = preparePins(raw, ["营收5.6个百分点"]);
    expect(p.text.split(PIN_OPEN).length - 1).toBe(2);
    const r = restorePins(p.text, p.pins);
    expect(r.missing).toEqual([]);
    expect(r.text).toBe(raw);
  });

  it("LLM 模式用可读标记：prepare/restore 往返，本地私用区 token 不混用", () => {
    const raw = "营收增长5.6个百分点，净利12.3%。";
    const p = preparePins(raw, ["营收增长5.6个百分点", "净利12.3%"], true);
    expect(p.text).toContain("⟦逐字保留0⟧");
    expect(p.text).not.toContain(PIN_OPEN);
    const r = restorePins(p.text, p.pins, true);
    expect(r.missing).toEqual([]);
    expect(r.text).toBe(raw);
  });

  it("原文自带占位符边界时拒绝钉住，不制造还原歧义", () => {
    const raw = `正常文本${PIN_OPEN}99${PIN_CLOSE}`;
    const p = preparePins(raw, ["正常文本"]);
    expect(p.pins).toEqual([]);
    expect(p.text).toBe(raw);
  });

  it("改写把占位符吃掉时 missing 非空（供调用方整篇回退）", () => {
    const r = restorePins(`${PIN_OPEN}0${PIN_CLOSE} 保留了`, ["数字5.6"]);
    expect(r.missing).toEqual([]);
    expect(r.text).toBe("数字5.6 保留了");
    const broken = restorePins("占位符被吃掉了", ["数字5.6"]);
    expect(broken.missing).toEqual([0]);
    expect(broken.text).toBe("占位符被吃掉了");
  });

  it("两档强度下钉住片段都能穿越本地引擎并逐字还原", () => {
    const raw =
      "值得注意的是，本项目在2026年11月19日完成升级，营收增长了5.6个百分点，这一数据来自公司官方财报。此外，团队还发布了新产品。";
    const pins = ["营收增长了5.6个百分点", "这一数据来自公司官方财报"];
    const p = preparePins(raw, pins);
    for (const intensity of [0.6, 0.9]) {
      const out = humanize(p.text, { intensity, seed: 42 });
      const r = restorePins(out, p.pins);
      expect(r.missing).toEqual([]);
      for (const pin of pins) expect(r.text).toContain(pin);
    }
  });
});

describe("autoStructurePins（--api 自动结构钉住，v0.9.90）", () => {
  const C23 = `---
title: 接入改造说明
date: 2026-10-18
---

本次改造要点如下：

- 首先，需要说明的是，接口层做了全面重构。

缩进代码块示例：

    const client = new Client();

总的来说，本次改造风险可控。`;

  it("C23：frontmatter 整块被提取为 pin，date 数字在块内", () => {
    const pins = autoStructurePins(C23);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toContain("date: 2026-10-18");
    expect(pins[0].startsWith("---\n")).toBe(true);
    expect(pins[0].trimEnd().endsWith("---")).toBe(true);
  });

  it("围栏代码块（含围栏行）也提取；与 frontmatter 同时存在时按位置排序", () => {
    const text = `---\ntitle: X\n---\n\n正文\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n\n结尾`;
    const pins = autoStructurePins(text);
    expect(pins).toHaveLength(2);
    expect(pins[0]).toContain("title: X");
    expect(pins[1]).toContain("const a = 1;");
    expect(pins[1].startsWith("```")).toBe(true);
  });

  it("无结构块返回空；空串不抛错", () => {
    expect(autoStructurePins("普通正文，没有结构块。")).toEqual([]);
    expect(autoStructurePins("")).toEqual([]);
  });

  it("结构块自带 pin 边界时跳过该块（preparePins 对整篇含边界仍拒绝，是既有防歧义行为）", () => {
    const text = `---\ntitle: ⟦逐字保留0⟧\n---\n\n正文`;
    expect(autoStructurePins(text)).toEqual([]);
    // 既有契约：原文自带边界 ⇒ preparePins 整体拒绝（防还原歧义），不是本轮要改的行为
    const p = preparePins(text, ["正文"], true);
    expect(p.pins).toEqual([]);
  });

  it("往返：结构块经 preparePins/restorePins 后逐字还原", () => {
    const pins = autoStructurePins(C23);
    const p = preparePins(C23, pins, true);
    expect(p.text).not.toContain("date: 2026-10-18"); // LLM 看不到原文数字
    const r = restorePins(p.text, p.pins, true);
    expect(r.missing).toEqual([]);
    expect(r.text).toBe(C23);
  });
});

describe("restorePinsWithRetry（v0.9.90 结构块保真重试）", () => {
  const TEXT = "开头正文。\n```js\nconst a = 1;\n```\n结尾正文。";
  const CODE = "```js\nconst a = 1;\n```";

  it("首次还原成功 → 不调 rewrite，retried=false", async () => {
    const p = preparePins(TEXT, [CODE], true);
    let called = 0;
    const r = await restorePinsWithRetry(p.text, p.pins, true, async () => {
      called++;
      return p.text;
    });
    expect(called).toBe(0);
    expect(r.retried).toBe(false);
    expect(r.missing).toEqual([]);
    expect(r.out).toBe(TEXT);
  });

  it("首次丢哨兵、重试保住 → retried=true、产出含原文片段", async () => {
    const p = preparePins(TEXT, [CODE], true);
    // 首稿把哨兵吞了；重稿原样带哨兵（模拟低强度改写保住了）。
    // p.text 是 preparePins 产出的带哨兵文本，token 就是其中的 ⟦逐字保留0⟧。
    const broken = "重写后的开头，代码略。";
    const good = "低强度改写。" + p.text + "。收尾。";
    let called = 0;
    const r = await restorePinsWithRetry(broken, p.pins, true, async () => {
      called++;
      return good;
    });
    expect(called).toBe(1);
    expect(r.retried).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.out).toContain(CODE);
  });

  it("重试仍丢哨兵 → missing 非空、out 为空串（调用方据此回退原文）", async () => {
    const p = preparePins(TEXT, [CODE], true);
    const r = await restorePinsWithRetry("坏稿A", p.pins, true, async () => "坏稿B");
    expect(r.retried).toBe(true);
    expect(r.missing).toEqual([0]);
    expect(r.out).toBe("");
  });

  it("无重试通道（本地引擎/null）→ 首次丢哨兵直接返回，不抛错", async () => {
    const p = preparePins(TEXT, [CODE], true);
    const r = await restorePinsWithRetry("坏稿", p.pins, true, null);
    expect(r.retried).toBe(false);
    expect(r.missing).toEqual([0]);
    expect(r.out).toBe("");
  });
});
