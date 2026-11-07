/**
 * structural-shuffle.ts —— 受限句序重排（--structural / opts.structural，默认关）
 *
 * ## 为什么要有它（对标缺口的最小安全版）
 *
 * SCORECARD「不能做什么」第 2/9 条写明：本地引擎"换词不换骨"，句序与段序不动——
 * 这是"不新增事实"的代价。竞品 sgaofen 用 12B 权重证明了"离线 + 结构级重写"有需求
 * （代价是 4GB 权重 + 中文 73% 事实保真）。本模块给出一条**不新增事实也成立**的
 * 中间路线：**只做相邻句交换**——产出是原句的一个排列，句的多重集逐字不变，
 * "不新增事实"在构造上成立（没有新句子、没有新词、没有新数字）。
 *
 * ## 为什么是"受限"（每条守卫背后都有一次真实翻车模式）
 *
 * 相邻句交换最大的风险不是改内容，是**改坏指代与逻辑顺序**：
 *   · 后句用「他/它/这」回指前句 → 交换后指代悬空（anaphora 守卫）
 *   · 「首先/其次/最后」「因此/但是」是作者的论证骨架 → 交换直接摧毁逻辑（序列/因果守卫）
 *   · 「总计 12 项。其中 5 项…」数字跨句引用 → 交换后算术语境断裂（数字守卫）
 *   · 对话引语锚定说话人语境 → 交换后张冠李戴（引语守卫）
 *   · 首句是段落的定场句（topic sentence）→ 永远不动（首句锚定）
 *   · 每段至多换一处 → 破坏"均匀结构指纹"所需的最小干预，多换只会放大风险
 *
 * ## 边界
 *
 *   · 只对**论说/公文/学术**体裁生效（叙事/人写沿用"保留作者结构"的既有裁决，
 *     证据链见 humanize.ts 结构层注释，P0 收敛六·续三）。
 *   · 调用方（humanize.ts 结构层）已做体裁与强度门控（≥0.55）；本模块再做
 *     段级防线（围栏/结构行/事实密集段/剧本行），双层保险。
 *   · 固定 seed 可复现；同输入同产出。
 *   · v0.9.85 起「开启即尝试」：不再用随机概率跳过。达到强度门槛就找守卫全过的
 *     相邻对；确实没有可换对时原样返回，调用方通过 `onStructuralApplied` 把
 *     「本轮是否真的换了」写进 --report，避免静默不生效。
 */
import { splitSentences, makeRng } from "./humanize-data.ts";
import { isProtectedBlock, isFactDenseParagraph, splitParasOutsideFences } from "./text-shield.ts";

/* ------------------------------ 守卫词表 ------------------------------ */

/** 回指开头：后句回指前句（人/物/指示），交换即悬空 */
const ANAPHORA_START_RE =
  /^(他们|她们|它们|这样|这么|那么|为此|对此|据此|其中|之[一二]|这些|那些|他|她|它|这|那|此|其|该)/;

/** 序列/因果/转折开头：作者的论证骨架，交换即摧毁 */
const SEQ_CAUSAL_START_RE =
  /^(首先|其次|再者|再次|然后|接着|最后|另外|此外|同时|与此同时|第一|第二|第三|第四|第五|一方面|另一方面|因此|所以|因而|于是|由此|但是|可是|不过|然而|而且|并且|况且|何况|换句话说|也就是说|具体来说|具体而言|例如|比如|譬如|总之|综上|换言之|也就是说|一般而言|通常来说|需要注意的是|值得注意)/;

/** 引语：任何引号字形在场即视为对话语境（说话人锚定在句序上）。
 *  单字符类而非alternation——check-regex-defects 门禁会拦「类后紧跟字面 ]」的写法 */
const QUOTE_RE = /[「『」』“”"]/;

/** 数字与序号：跨句数字引用（"总计 X。其中 Y…"）交换后算术语境断裂 */
const NUM_RE = /[0-9０-９]|[%％]|[百千万亿]|第[一二三四五六七八九十\d]/;

/** 过短句不参与交换：切句碎片化语境下，短句多为承接/语气成分 */
const MIN_SENT_CHARS = 8;

/** 每段最多交换次数：最小干预原则 */
const MAX_SWAPS_PER_PARA = 1;

/**
 * 结构层强度门槛，与 humanize.ts 的 `intensity >= 0.55` 同口径。
 *
 * v0.9.85 之前这里是概率门控 `SWAP_PROB = 0.55`：`rng() > 0.55 * intensity`
 * 就整段跳过。30 种子实测只有 14/30 触发交换（0.7 档约 45% / 1.0 档约 78%），
 * 用户开了开关却看不出变化会被当成功能坏了，且没有任何字段能查「到底换没换」。
 * ⇒ 改为「开启即尝试」：低于门槛恒不动，达到门槛就找守卫全过的相邻对；
 *   确实没有可换对时原样返回，并由 `onStructuralApplied` 把结果报出去。
 * rng 仍用于选候选对，同 seed 同产出不变。
 */
const MIN_STRUCTURAL_INTENSITY = 0.55;

function sentenceStartsDangerously(s: string): boolean {
  return ANAPHORA_START_RE.test(s) || SEQ_CAUSAL_START_RE.test(s);
}

function swappable(s: string): boolean {
  return (
    s.length >= MIN_SENT_CHARS &&
    !sentenceStartsDangerously(s) &&
    !QUOTE_RE.test(s) &&
    !NUM_RE.test(s)
  );
}

/** 段内寻找一个可交换的相邻对（i≥1，首句固定），找不到返回 -1 */
function findSwapIndex(sents: string[], rng: () => number): number {
  const candidates: number[] = [];
  for (let i = 1; i < sents.length - 1; i++) {
    // 交换 sents[i] 与 sents[i+1]：两句都必须可动
    if (swappable(sents[i]) && swappable(sents[i + 1])) candidates.push(i);
  }
  if (candidates.length === 0) return -1;
  return candidates[Math.floor(rng() * candidates.length) % candidates.length];
}

/**
 * 单段受限句序重排。低于强度门槛、守卫不过或找不到可换对时原样返回。
 * 产出是原句排列——句多重集与原文逐字相同（测试锁定这一性质）。
 */
export function sentenceShuffleParagraph(p: string, rng: () => number, intensity: number): string {
  const sents = splitSentences(p);
  if (sents.length < 3) return p; // 至少 3 句才有（i≥1, i+1）的交换空间
  if (intensity < MIN_STRUCTURAL_INTENSITY) return p;
  const idx = findSwapIndex(sents, rng);
  if (idx < 0) return p;
  const out = [...sents];
  [out[idx], out[idx + 1]] = [out[idx + 1], out[idx]];
  return out.join("");
}

/**
 * 全文受限句序重排。段落切分、围栏块、结构行、事实密集段一律不动；
 * 只有"普通论说段落"里守卫全过的相邻对可能被交换。
 */
export function structuralSentenceShuffle(
  text: string,
  rng: () => number,
  intensity: number,
): string {
  if (!text) return text;
  return splitParasOutsideFences(text)
    .map((p) => {
      // 段级防线：冻结块（围栏/列表/引用/缩进/frontmatter/setext）/事实密集段照旧（与结构层同口径）
      if (isProtectedBlock(p) || isFactDenseParagraph(p)) return p;
      // ATX 标题行（MD_STRUCT_RE 不含 #，2026-11-03 测试抓到）与剧本【场景】行不参与
      if (/^[ \t]*#{1,6}[ \t]/.test(p) || /^【/.test(p.trim())) return p;
      return sentenceShuffleParagraph(p, rng, intensity);
    })
    .join("\n\n");
}

/** 供测试与探针复用的守卫判定（别再抄一份词表） */
export const STRUCTURAL_GUARDS = {
  ANAPHORA_START_RE,
  SEQ_CAUSAL_START_RE,
  QUOTE_RE,
  NUM_RE,
  MIN_SENT_CHARS,
  MAX_SWAPS_PER_PARA,
  MIN_STRUCTURAL_INTENSITY,
  swappable,
};

/** makeRng re-export：调用方（humanize.ts）已有 structRng，这里只服务独立使用者 */
export { makeRng as structuralMakeRng };
