/**
 * src/engine/low-yield.ts —— `--skip-low-risk` 的「低收益风险」判据（CLI 专用，不改引擎行为）
 *
 * ## 为什么换掉 v0.9.84 的 `aiScore≤27 && formalHits≤2`
 *
 * 误伤基准台 P1-1 首跑（evidence/collateral-bench-2026-11-08/）里，这个判据在
 * 21 篇「不该动」真人长文上 **0 命中**，却在 23 篇「该改」短稿上命中 13 篇。
 * 归因脚本（scripts/collateral-attribution.ts）实测：
 *   · 字数 ~ formalHits 相关 **0.958**（no-touch 内部 0.939）⇒ 原始命中数本质是长度函数，
 *     `<=2` 对长文构造性不可能满足；
 *   · 字数 ~ aiScore 相关 0.785 ⇒ aiScore 门也在按长度筛人；
 *   · 两面板长度区间完全不重叠（2160~27267 字 vs 53~453 字）⇒ 旧阈值是在短稿上标定的，
 *     任何含长度项的「改进」都只是标签泄漏，不能当能力。
 *
 * ## 新判据
 *
 * `formalPer1k <= 8`（书面标记**密度**，分母只数 CJK 字，与 registerIndex 同口径）。
 * 8/千字 也是 registerIndex 的单向封顶密度：低于它，删套话规则作用对象稀薄，
 * 改写主要只能动断句和用词——这正是「低收益风险」原本要描述的机制。
 * 不再看 aiScore：跨文本绝对分不可比（项目已承认），真人维基长文能到 95 分。
 *
 * ## 44 篇基准台上的模拟读数（只报告，不是能力承诺）
 *
 * no-touch 命中 15/21、should-change 误跳 10/23（旧判据 13/23）；
 * 开启开关后模拟残余误伤率 57%→14%，该改面板达改率 17% 不变。
 * 双网关 0.9 档配对交叉核对：被误跳的 10 篇全部至少一席判改写更像人
 * ⇒ **开启开关 = 主动放弃这部分改善**，所以开关仍然默认关。
 * ## 交叉长度语料复核（evidence/collateral-cross-2026-11-09/）
 *
 * 补了「短真人稿」象限（15 篇中文维基短条目，191~457 字，与 should-change 面板同区间）：
 *
 * | 面板 | n | 密度中位 | 命中率 |
 * |---|---|---|---|
 * | 短真人稿 | 15 | 4.6 | 80.0% |
 * | 长真人稿 | 21 | 6.4 | 71.4% |
 * | AI 短稿 | 23 | 12.5 | 43.5% |
 *
 * - 短真人稿密度比长真人稿还低 ⇒ 判它「低收益」是正确行为，不是误判。
 * - 同长度区间（150~460 字）真人 80% vs AI 40%，**AUC 0.683** ⇒ 长度对齐后仍有区分力，
 *   判据不是按长度筛；但 0.683 只算中等，20 篇同区间 AI 稿仍有 8 篇被误跳。
 * - 长度分层（长文按 400/800/1600/3200 字切）密度中位 5.7/6.1/5.1/5.8 ⇒ 不随长度漂移。
 *
 * ⚠️ 未解决的限制：①H-short 全是百科体、AI-short 全是营销/公文/技术体，
 * 体裁与来源的混淆**没有分离**；②长 AI 稿未实测（本机 LLM 网关 2026-11-09 不可达）；
 * ③样本量 15 篇，AUC 0.683 置信区间不窄。⇒ 仍属探索性归因，开关继续默认关。
 *
 * 本模块只被 CLI 入口层与误伤基准台引用；`adviceFor` / `humanize()` / Web / MCP / API 行为不变。
 */
import { registerIndex } from "./register-metrics.ts";

/** 书面标记密度阈值（每千字）。与 registerIndex 的 CAP_PER_1K 同量纲。 */
export const LOW_YIELD_FORMAL_PER_1K = 8;

export interface LowYieldSignals {
  /** 原文字符数（含标点空白），仅用于报告 */
  chars: number;
  /** 分母：只数 CJK 字 */
  cjkChars: number;
  /** 未归一的原始命中数（旧判据用的就是它） */
  formalHits: number;
  /** 长度归一后的书面标记密度 */
  formalPer1k: number;
  thresholdPer1k: number;
  /** 是否判为低收益风险 */
  hit: boolean;
}

export function lowYieldSignals(text: string): LowYieldSignals {
  const reg = registerIndex(text);
  return {
    chars: text.length,
    cjkChars: reg.countedChars,
    formalHits: reg.formalHits,
    formalPer1k: reg.formalPer1k,
    thresholdPer1k: LOW_YIELD_FORMAL_PER_1K,
    hit: reg.formalPer1k <= LOW_YIELD_FORMAL_PER_1K,
  };
}

/** `--skip-low-risk` 的唯一判据入口。stdin 与批量共用，避免两处漂移。 */
export function isLowYieldRisk(text: string): boolean {
  return lowYieldSignals(text).hit;
}

/**
 * v0.9.84 旧判据，**只在归因/基准台里做对照**，产品路径不再调用。
 * 保留它才能让「0 命中」这件事在报告里可复现。
 */
export function isLegacyLowYieldRisk(text: string, score: number): boolean {
  return score <= 27 && registerIndex(text).formalHits <= 2;
}
