import { describe, it, expect } from "vitest";
import { humanize } from "../src/engine/humanize";
import {
  PIN_OPEN,
  PIN_CLOSE,
  PIN_MIN_CHARS,
  parsePinFile,
  preparePins,
  restorePins,
} from "./pin-guard";

describe("parsePinFile", () => {
  it("一行一段；空行/注释/过短跳过，保留行内空格与重复去重", () => {
    const r = parsePinFile(
      ["", "  ", "# 这是注释", "短", "营收增长了5.6个百分点", "营收增长了5.6个百分点", " 带 空格 的 片段 "].join("\n"),
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
