import { describe, it, expect } from "vitest";
import { scanInputJunk, cleanInputJunk, SAMPLES_MAX, type JunkKind } from "./input-hygiene";

describe("input-hygiene · scanInputJunk · 隐形字符", () => {
  it("零宽/joiner/NBSP 都算命中，标签带码位", () => {
    const r = scanInputJunk("甲\u200B乙\u2060丙\u00A0丁");
    expect(r.invisible.count).toBe(3);
    const labels = r.invisible.samples.map((s) => s.label);
    expect(labels).toContain("零宽空格 U+200B");
    expect(labels).toContain("word joiner U+2060");
    expect(labels).toContain("不换行空格 NBSP U+00A0");
  });

  it("全部命中进入计数，但样本至多 SAMPLES_MAX 条", () => {
    const r = scanInputJunk("零\u200B宽\u200B字\u200B符\u200B们\u200B啊");
    expect(r.invisible.count).toBe(5);
    expect(r.invisible.samples.length).toBe(SAMPLES_MAX);
  });

  it("上下文字段用于定位：中段命中两侧都带省略号", () => {
    const mid = "一二三四五六七八九十甲乙" + "\u200B" + "丙丁戊己庚辛壬癸子丑";
    const r = scanInputJunk(mid);
    expect(r.invisible.samples[0].snippet).toMatch(/^…/);
    expect(r.invisible.samples[0].snippet).toMatch(/…$/);
  });

  it("干净文本：三类全零", () => {
    const r = scanInputJunk("这是一段普通的文字，没有任何问题。");
    expect(r.invisible.count).toBe(0);
    expect(r.chatbot.count).toBe(0);
    expect(r.punct.count).toBe(0);
    expect(r.total).toBe(0);
  });
});

describe("input-hygiene · scanInputJunk · 聊天残渣", () => {
  it("独立成行的包装语命中，正文中的同款词语不命中", () => {
    const text =
      "以下是改写后的版本：\n" +
      "正文第一句。\n" +
      "希望这对你有帮助。\n" +
      "第二句里我提到了「以下是改写后的版本」这个说法，但它不是残渣。";
    const r = scanInputJunk(text);
    expect(r.chatbot.count).toBe(2);
    const labels = r.chatbot.samples.map((s) => s.label);
    expect(labels[0]).toContain("改写包装语");
    expect(labels[1]).toContain("客服式收尾");
  });

  it("续写追问与留联语按独立行命中；但「需要我帮忙吗？」这类正文口语不动", () => {
    const r = scanInputJunk("需要我继续吗？\n有问题随时告诉我。\n需要我帮忙吗？");
    expect(r.chatbot.count).toBe(2);
  });

  it("代码围栏内的同款行跳过：文档在讨论这些包装语时不能误删", () => {
    const text = "```md\n以下是改写后的版本：\n希望这对你有帮助。\n```\n正文。";
    const r = scanInputJunk(text);
    expect(r.chatbot.count).toBe(0);
  });

  it("英文收尾语命中（大小写不敏感）", () => {
    const r = scanInputJunk("I hope this helps.\nlet me know if you have questions.");
    expect(r.chatbot.count).toBe(2);
  });
});

describe("input-hygiene · scanInputJunk · 重复标点", () => {
  it("。，、；： 的同类重复命中；！？的强调连用不碰", () => {
    const r = scanInputJunk("好。。真的，，假的、、完了；；痛！！！！");
    expect(r.punct.count).toBe(4);
    const labels = r.punct.samples.map((s) => s.label);
    expect(labels).toContain("重复句号（。。）");
    expect(labels).toContain("重复逗号（，，）");
  });

  it("一组连续重复算一处命中（「。。。」是 1 处不是 2 处）", () => {
    const r = scanInputJunk("等等。。。继续");
    expect(r.punct.count).toBe(1);
  });
});

describe("input-hygiene · cleanInputJunk", () => {
  const DIRTY =
    "以下是改写后的版本：\n" +
    "甲\u200B乙\u00A0丙好。。\n" +
    "希望这对你有帮助。\n" +
    "正文最后一句。";

  it("三类一起清：删隐形、空怪异、去包装语行、收敛标点，逐字核对产出", () => {
    const r = cleanInputJunk(DIRTY);
    expect(r.text).toBe("甲乙 丙好。\n正文最后一句。");
    expect(r.removed).toEqual({ invisible: 2, chatbot: 2, punct: 1 });
    expect(r.total).toBe(5);
  });

  it("幂等：清洗结果再清洗，逐字不变且计数全零", () => {
    const once = cleanInputJunk(DIRTY);
    const twice = cleanInputJunk(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.total).toBe(0);
  });

  it("无命中文本逐字原样返回（不做 trim、不动空白）", () => {
    const text = "  他说，明天早点到。\n\n就这样。  ";
    const r = cleanInputJunk(text);
    expect(r.text).toBe(text);
    expect(r.total).toBe(0);
  });

  it("删行留下的多余空行收敛（3+ 换行 → 2），只在真的删了行时发生", () => {
    const r = cleanInputJunk("甲。\n\n以下是改写后的版本：\n\n乙。");
    expect(r.text).toBe("甲。\n\n乙。");
    expect(r.removed.chatbot).toBe(1);
  });

  it("围栏内包装语保留，围栏外的照删", () => {
    const text = "以下是改写后的版本：\n```md\n以下是改写后的版本：\n```\n正文。";
    const r = cleanInputJunk(text);
    expect(r.text).toBe("```md\n以下是改写后的版本：\n```\n正文。");
    expect(r.removed.chatbot).toBe(1);
  });

  it("确定性：同一输入重复扫描结果一致（JSON 全等）", () => {
    const a = JSON.stringify(scanInputJunk(DIRTY));
    const b = JSON.stringify(scanInputJunk(DIRTY));
    expect(a).toBe(b);
  });

  it("kind 字段与分类一一对应（供 UI 分栏展示）", () => {
    const r = scanInputJunk(DIRTY);
    const kinds: JunkKind[] = [
      r.invisible.samples[0].kind,
      r.chatbot.samples[0].kind,
      r.punct.samples[0].kind,
    ];
    expect(kinds).toEqual(["invisible", "chatbot", "punct"]);
  });
});
