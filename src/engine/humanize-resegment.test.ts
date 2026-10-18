/**
 * humanize-resegment.test.ts —— 拆段门控（v0.9.55）：拆段不因**自家切句**而触发
 *
 * ## 起因（realcase C9-mixed-links 软提示「段落数变化 6→7」，命中 10 组里的 3 组）
 *
 * 实测根因链条（分层探针：逐步重放 structuralShuffleParagraph → resegmentParagraphsAggressive
 * 并配合 `[structure]` onStage 段计数）：
 *   ① P3 纯切句 `boostBurstinessByCutting` 把通告段
 *      「接口地址变更为 X**，**旧地址将于 Y 停止服务。」从逗号处切成两句；
 *   ② 本段句数因此 2→3，恰好够到 `resegmentParagraphsAggressive` (b) 分支的
 *      `sentences >= 3` 门槛；
 *   ③ 结构层顺手把这 URL / 邮箱俱全的事实通告段拆成两段 —— 整篇 6→7 行。
 *
 * 作者写这个通告段时并没有把它断成两段的意思：逗号是**同一句子内部**的停顿。
 * 拆段规则针对的是「AI 典型多句均匀段」，不该拿自家手术制造出来的句子数当改造理由。
 *
 * ## 修法
 *
 * `resegmentParagraphsAggressive` 增加可选第 4 参 `origSentCounts`（原文每段句数，
 * 与 `\n{2,}` 段落一一对应）：(b) 分支只拆「原文就 ≥3 句」的段。
 * 长度对不上（层间已改过段落结构，索引映射不可信）⇒ 整段退回旧行为。
 * `humanize.ts` 主链路与 `shuffle/orchestrator.ts` 独立入口各自传入原文句数。
 *
 * ## 变异检验（别靠猜）
 *
 * 把 structure.ts (b) 分支里 `(origGate === undefined || (origGate[i] ?? 99) >= 3)` 这一行
 * 整行删掉重跑 → 本文件「原文 2 句被自家切句成 3 句 → 不允许拆段」用例立即红（输出 6 段），
 * 对照组与 e2e 保持绿 ⇒ 这条断言单条敏感，不是靠别的红撑场面。
 */
import { describe, expect, it } from "vitest";
import { humanize } from "./humanize.ts";
import { resegmentParagraphsAggressive } from "./humanize-shuffle.ts";

/** 与 run.ts 同口径：非空行数 = 段数 */
const paraCount = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean).length;

/**
 * P3 切句**之后**的形态（逗号已变句号 ⇒ 结构性 3 句），原文其实只有 2 句。
 * 这正是 C9 在结构层看到的文本。
 */
const P2_AFTER_CUT =
  "接口地址变更为 https://api.example.com/v2/gateway。旧地址将于 2026-12-31 停止服务。技术对接请联系 dev-support@example.com。";

/** 5 段：p2 两侧都是短句段（既不会进合并窗口，也不会被 CV 强制），把 rng 全部留给 p2 的拆段判定 */
const T = [
  "本次 API 升级说明如下：",
  P2_AFTER_CUT,
  "调用示例：",
  "完成后即可启动服务。",
  "需要注意的是，新版本对请求频率做了限制。",
].join("\n\n");

/** 0.1 < 0.3 + 0.35×0.9 = 0.615 ⇒ 无门控时 (b) 分支必拆 */
const rngSplit = () => 0.1;

describe("resegmentParagraphsAggressive 拆段门控（原文句数）", () => {
  it("原文 2 句被自家切句成 3 句 → 不允许拆段（C9 根因）", () => {
    // 原文该段 2 句（逗号停顿不算），即使现在数出 3 句也不拆
    expect(resegmentParagraphsAggressive(T, rngSplit, 0.9, [1, 2, 1, 1, 1])).toBe(T);
  });

  it("对照组：原文本就 3 句 → 拆段照常发生（门控没有把能力整体冻死）", () => {
    const out = resegmentParagraphsAggressive(T, rngSplit, 0.9, [1, 3, 1, 1, 1]);
    expect(out.split(/\n\n+/).length).toBe(6);
    // 位置也对：第一段只留第 1 句
    expect(out.split(/\n\n+/)[1]).toBe("接口地址变更为 https://api.example.com/v2/gateway。");
  });

  it("长度对不上（层间已改段落结构）→ 保守退回旧行为（照拆）", () => {
    const out = resegmentParagraphsAggressive(T, rngSplit, 0.9, [1, 2]);
    expect(out.split(/\n\n+/).length).toBe(6);
  });

  it("不传第 4 参（旧调用方）→ 行为与 v0.9.54 完全一致（照拆）", () => {
    expect(resegmentParagraphsAggressive(T, rngSplit, 0.9).split(/\n\n+/).length).toBe(6);
  });
});

describe("C9-mixed-links 端到端：段落数 6→6（软提示根治）", () => {
  /** 与 scripts/realcase/cases.json 逐字一致（genre=auto，由 humanize 默认值接管） */
  const C9 =
    "本次 API 升级说明如下：\n\n" +
    "接口地址变更为 https://api.example.com/v2/gateway，旧地址将于 2026-12-31 停止服务。技术对接请联系 dev-support@example.com。\n\n" +
    "调用示例：\n\n" +
    'const resp = await fetch(url, { method: "POST", headers: { "X-Token": token } });\n' +
    'if (!resp.ok) throw new Error("gateway 5xx");\n\n' +
    "需要注意的是，新版本对请求频率做了限制，QPS 上限为 20。此外，返回结果中的 user_id 字段类型由 number 调整为 string，请务必做好兼容处理。";

  // 前两组是当年命中的组合；后两组是宽裕度检查（历史上没命中，修后也不许动）
  for (const [seed, intensity] of [
    [2026, 0.9],
    [2026, 1],
    [20261015, 1],
    [20261015, 0.9],
  ] as const) {
    it(`seed=${seed} 强度=${intensity}：段落数 6→6`, () => {
      expect(paraCount(C9)).toBe(6);
      const out = humanize(C9, { intensity, seed });
      expect(paraCount(out), out).toBe(6);
    });
  }

  it("修的是拆段，不是把文本冻住：抽样组合仍必须真的改写正文", () => {
    const out = humanize(C9, { intensity: 0.9, seed: 2026 });
    expect(out).not.toBe(C9);
  });
});
