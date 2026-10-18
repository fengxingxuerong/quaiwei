import { describe, expect, it } from "vitest";
import { applyZhuqueFeatures, humanizeSingle } from "./humanize-zhuque-apply";
import { suppressSelfQA } from "./classify-genre";
import type { StageTrace } from "./humanize-primitives";

const FORMAL =
  "根据上级部门要求，现将本季度安全生产工作情况总结如下。各部门要清醒地认识到当前形势，把责任层层压实。";

/**
 * 引擎单条文本主入口 humanizeSingle + 朱雀增强层 applyZhuqueFeatures 的**直测**。
 *
 * 此前这条路径全走 humanize() 间接覆盖：两大入口自身的早退守卫
 * （强度 <0.35 短路 / 空文本 / 场景块全格式保真 / officialDoc 缺省判定）
 * 从没有用例直接锁过——间接覆盖碰不到，出问题时也说不清是哪一层。
 */

describe("applyZhuqueFeatures 强度门槛", () => {
  it("强度低于 0.35 → 原文逐字返回（硬门槛短路）", () => {
    const text = "这事就这么定了，回头再说。";
    expect(applyZhuqueFeatures(text, 0.2)).toBe(text);
    expect(applyZhuqueFeatures(text, 0.34)).toBe(text);
  });

  it("空文本 → 原样返回空串（非空文本同一守卫的另一半）", () => {
    expect(applyZhuqueFeatures("", 0.9)).toBe("");
  });

  it("段落列表含纯空白段：跳过该段不炸，真实段落内容保留", () => {
    // 段落级注入（碎片）按 /\n\n+/ 分段；空段是切分痕迹，
    // 注入器必须跳过而不是把碎片挂到空段后面。
    const text =
      "周一早上例会，领导把进度表投到屏幕上。\n\n   \n\n散会后大家各自回工位，把手头的事继续做完。";
    const out = applyZhuqueFeatures(text, 0.9, 7, "casual");
    expect(out).toContain("周一早上例会");
    expect(out).toContain("散会后大家各自回工位");
  });

  it("文本以空段开头（换行切分痕迹）→ 空段被丢弃，不会挂在输出开头", () => {
    const text = "\n\n开完会已经六点多了，天色擦黑。\n\n路上给家里打了个电话，说晚点到家。";
    const out = applyZhuqueFeatures(text, 0.9, 5, "casual");
    expect(out).toContain("开完会已经六点多了");
    expect(out.startsWith("\n")).toBe(false);
  });
});

describe("humanizeSingle 早退守卫", () => {
  it("空文本与纯空白 → 返回空串", () => {
    expect(humanizeSingle("")).toBe("");
    expect(humanizeSingle("   \n  ")).toBe("");
  });

  it("整段皆场景块头行 → 原样返回，任何替换都不发生", () => {
    const block = "【场景：深夜的出租屋，窗外雨声不断。】";
    expect(humanizeSingle(block, { intensity: 0.9, seed: 1 })).toBe(block);
  });

  it("trace 模式：场景块短路同样发射 scene-block 事件（带段落号）", () => {
    const events: StageTrace[] = [];
    const block = "【场景：黄昏的老码头。】";
    const out = humanizeSingle(block, {
      intensity: 0.9,
      seed: 1,
      para: 3,
      onStage: (s) => events.push(s),
    });
    expect(out).toBe(block);
    const ev = events.find((e) => e.id === "scene-block");
    expect(ev?.name).toContain("场景块");
    expect(ev?.para).toBe(3);
  });

  it("trace 模式无段落号：事件不带 para 字段（{} 那一支）", () => {
    const events: StageTrace[] = [];
    humanizeSingle("【场景：清晨的出租车站。】", {
      intensity: 0.9,
      seed: 1,
      onStage: (s) => events.push(s),
    });
    const ev = events.find((e) => e.id === "scene-block");
    expect(ev).toBeDefined();
    expect(ev?.para).toBeUndefined();
  });

  it("trace 模式跑完主链：step 事件带段落号，来源段落原样透传", () => {
    const events: StageTrace[] = [];
    humanizeSingle(FORMAL, { intensity: 0.9, seed: 42, para: 5, onStage: (s) => events.push(s) });
    const conn = events.find((e) => e.id === "conn");
    expect(conn).toBeDefined();
    expect(conn?.para).toBe(5);
  });

  it("trace 模式无段落号跑主链：step 事件不带 para 字段", () => {
    const events: StageTrace[] = [];
    humanizeSingle(FORMAL, { intensity: 0.9, seed: 42, onStage: (s) => events.push(s) });
    const conn = events.find((e) => e.id === "conn");
    expect(conn).toBeDefined();
    expect(conn?.para).toBeUndefined();
  });
});

describe("openerFrozen：officialDoc 缺省时按原文形态自动判定", () => {
  it("签名公文：不传 officialDoc 与显式 officialDoc:true 的输出逐字一致", () => {
    expect(suppressSelfQA(FORMAL)).toBe(true);
    const auto = humanizeSingle(FORMAL, { intensity: 0.9, seed: 42 });
    const explicit = humanizeSingle(FORMAL, { intensity: 0.9, seed: 42, officialDoc: true });
    expect(auto).toBe(explicit);
  });
});
