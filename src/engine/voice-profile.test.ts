import { describe, it, expect } from "vitest";
import {
  extractVoiceProfile,
  voiceDirectiveBlock,
  VOICE_SAMPLE_MIN,
  VOICE_QUOTE_MAX,
} from "./voice-profile";
import { splitSentences } from "./humanize-text";

/** 确定性样本：全短句（每句 ≤10 可见字符，重复到过 100 字门槛） */
const ALL_SHORT = "好啊。行吧。就这。走起。".repeat(9);

/** 确定性样本：单长句（≥40 可见字符，且过 100 字门槛） */
const ALL_LONG = "很长很长".repeat(26) + "。";

/** 通用样本：混长短句 + 破折号，供注入与确定性用例（>100 可见字符） */
const MIXED =
  "我写东西不太讲究结构，想到哪写到哪。" +
  "句子一会儿长一会儿短，有时候还会冒出一句特别短的。" +
  "偶尔用个破折号——但不多。" +
  "反正意思到了就行。" +
  "说白了就是随性。" +
  "写多了自然知道哪里该停。" +
  "有时候一句话能绕好几个弯，把读者的耐心全都磨光。";

describe("voice-profile · extractVoiceProfile", () => {
  it("空白 / 过短样本返回 null（宁可不注入也不瞎画像）", () => {
    expect(extractVoiceProfile("")).toBeNull();
    expect(extractVoiceProfile("   \n\t ")).toBeNull();
    expect(extractVoiceProfile("太短。")).toBeNull();
    expect(extractVoiceProfile("字".repeat(VOICE_SAMPLE_MIN - 1))).toBeNull();
    // JS 运行时误传空值：与空串同路径（TS 签名外，但调用方是 UI 状态，保留兜底）
    expect(extractVoiceProfile(undefined as unknown as string)).toBeNull();
    expect(extractVoiceProfile(null as unknown as string)).toBeNull();
  });

  it("恰好达到最少字符数即生效（边界不多不少）", () => {
    const prof = extractVoiceProfile("字".repeat(VOICE_SAMPLE_MIN));
    expect(prof).not.toBeNull();
    expect(prof!.chars).toBe(VOICE_SAMPLE_MIN);
  });

  it("全短句样本：shortRatio=1 / longRatio=0，句数与 canonical 切句一致", () => {
    const prof = extractVoiceProfile(ALL_SHORT)!;
    expect(prof.sentences).toBe(splitSentences(ALL_SHORT).length);
    expect(prof.shortRatio).toBe(1);
    expect(prof.longRatio).toBe(0);
    expect(prof.avgLen).toBeLessThanOrEqual(10);
  });

  it("单长句样本：longRatio=1，CV=0（只有一句时无语内起伏）", () => {
    const prof = extractVoiceProfile(ALL_LONG)!;
    expect(prof.longRatio).toBe(1);
    expect(prof.shortRatio).toBe(0);
    expect(prof.cv).toBe(0);
  });

  it("破折号按组计数：有 —— 则密度 >0，没有则恒 0", () => {
    const withDash = extractVoiceProfile(MIXED)!;
    expect(withDash.dashPer1k).toBeGreaterThan(0);
    const noDash = extractVoiceProfile(
      "这是一段没有任何特殊标点习惯的普通文字，用来对照破折号密度为零的下界情况。" +
        "句子也不算短，内容足够长，能顺利越过画像所需的最少字符数门槛，得到一份真实的对照画像。" +
        "这样长短搭配的写法在真实写作里其实很常见。",
    )!;
    expect(noDash.dashPer1k).toBe(0);
    expect(noDash.ellipsisPer1k).toBe(0);
  });

  it("确定性：同一输入两次画像逐字段相同", () => {
    expect(extractVoiceProfile(MIXED)).toEqual(extractVoiceProfile(MIXED));
  });
});

describe("voice-profile · voiceDirectiveBlock", () => {
  it("空 / 过短样本不产生指令块（返回空串，调用方零分支拼接）", () => {
    expect(voiceDirectiveBlock()).toBe("");
    expect(voiceDirectiveBlock("")).toBe("");
    expect(voiceDirectiveBlock("太短。")).toBe("");
  });

  it("有效样本：含画像数字、密度覆盖声明与样本节选", () => {
    const block = voiceDirectiveBlock(MIXED);
    expect(block).toContain("声线样本");
    expect(block).toContain("样本画像");
    expect(block).toContain("覆盖");
    expect(block).toContain("整篇最多一次");
    expect(block).toContain("样本节选");
    expect(block).toContain("我写东西不太讲究结构");
  });

  it("超长样本：节选被截断且首句保留、尾句剔除（按句末收尾）", () => {
    const long =
      "开头的这句话一定要在。" + "中间撑篇幅的句子，反复出现。".repeat(60) + "尾巴标记句别出现。";
    expect(long.length).toBeGreaterThan(VOICE_QUOTE_MAX);
    const block = voiceDirectiveBlock(long);
    expect(block).toContain("开头的这句话一定要在");
    expect(block).not.toContain("尾巴标记句别出现");
    // 截断后的节选以句末标点收尾，不切在句子中间
    expect(/[。！？…；」』”）)]\s*$/.test(block)).toBe(true);
  });

  it("无句末标点的超长样本：硬截返回（不崩、不返回空）", () => {
    const noPunct = "很长的句子没有句末标点".repeat(150); // 1650 可见字符
    const block = voiceDirectiveBlock(noPunct);
    expect(block).toContain("样本节选");
    expect(block.length).toBeGreaterThan(VOICE_QUOTE_MAX);
    // 样本本身没有标点可回退：硬截，节选不以句末标点收尾
    expect(/[。！？…；」』”）)]\s*$/.test(block)).toBe(false);
  });

  it("句末标点出现得过早：不把它当收尾点（保留阈值 1/3），仍硬截", () => {
    const early = "短。" + "很长的句子没有句末标点".repeat(150);
    const block = voiceDirectiveBlock(early);
    expect(block).toContain("样本节选");
    expect(/短。\s*$/.test(block)).toBe(false);
  });
});
