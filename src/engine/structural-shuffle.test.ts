/**
 * structural-shuffle 单测：受限句序重排的保真性质与守卫。
 *
 * 核心不变式（本模块存在的理由）：**产出是原句排列，句多重集逐字不变**——
 * "不新增事实"在构造上成立。守卫测试逐条对应真实翻车模式（见模块头注释）。
 */
import { describe, it, expect } from "vitest";
import {
  sentenceShuffleParagraph,
  structuralSentenceShuffle,
  STRUCTURAL_GUARDS,
  structuralMakeRng,
} from "./structural-shuffle";

const rng = (seed: number) => structuralMakeRng(seed, 9999);

/** 四句论说段：无指代/无序列词/无引语/无数字，全部可换 */
const CLEAN =
  "第一段起头这句话先钉在这里。城市更新需要长期投入。资金来源决定项目成败。居民参与影响最终效果。";

function multiset(s: string): string[] {
  return s.match(/[^。！？]+[。！？]/g)?.sort() ?? [];
}

describe("sentenceShuffleParagraph：保真不变式", () => {
  it("句多重集不变——交换是排列，不是改写", () => {
    const out = sentenceShuffleParagraph(CLEAN, rng(7), 0.9);
    expect(multiset(out).sort()).toEqual(multiset(CLEAN).sort());
    expect(out.length).toBe(CLEAN.length);
  });

  it("首句永远不动（定场句锚定）", () => {
    for (let seed = 0; seed < 40; seed++) {
      const out = sentenceShuffleParagraph(CLEAN, rng(seed), 1);
      expect(out.startsWith("第一段起头这句话先钉在这里。")).toBe(true);
    }
  });

  it("确定性：同 seed 同产出", () => {
    expect(sentenceShuffleParagraph(CLEAN, rng(7), 0.9)).toBe(
      sentenceShuffleParagraph(CLEAN, rng(7), 0.9),
    );
  });

  it("弱强度下基本不动（概率门控）", () => {
    let moved = 0;
    for (let seed = 0; seed < 40; seed++) {
      if (sentenceShuffleParagraph(CLEAN, rng(seed), 0.2) !== CLEAN) moved++;
    }
    expect(moved).toBeLessThan(8); // 0.55*0.2=0.11 命中率，40 次里显著少数
  });
});

describe("守卫：每条对应一种真实翻车模式", () => {
  const cases: [name: string, text: string][] = [
    ["回指开头：交换后指代悬空", "老张把车停在了路边。他锁好车门进了楼。雨开始下了起来。"],
    [
      "序列骨架：首先/其次交换即摧毁论证顺序",
      "这件事要从头说起。首先，你得有一份稳定收入。其次，你得控制开销。最后才是投资。",
    ],
    ["因果衔接：因此句回指前句结论", "这家公司连年亏损。因此董事会决定重组。消息传出后股价大跌。"],
    [
      "引语锚定：说话人语境在句序上",
      "会议开了整整一下午。他说：「这个方案必须重来。」没有人反驳。",
    ],
    [
      "数字跨句引用：总计/其中交换后算术语境断裂",
      "本次共收到简历 120 份。其中 35 份进入初筛。最终录取 5 人。",
    ],
  ];

  for (const [name, text] of cases) {
    it(name, () => {
      for (let seed = 0; seed < 60; seed++) {
        expect(sentenceShuffleParagraph(text, rng(seed), 1)).toBe(text);
      }
    });
  }

  it("守卫词表本身可复查", () => {
    expect(STRUCTURAL_GUARDS.swappable("他锁好车门进了楼。")).toBe(false);
    expect(STRUCTURAL_GUARDS.swappable("资金来源决定项目成败。")).toBe(true);
    expect(STRUCTURAL_GUARDS.swappable("短句。")).toBe(false); // 过短
  });
});

describe("structuralSentenceShuffle：段级防线", () => {
  it("围栏代码块整块不动", () => {
    const text =
      "说明如下。\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\n其余照旧。资金来源决定项目成败。居民参与影响最终效果。";
    for (let seed = 0; seed < 30; seed++) {
      const out = structuralSentenceShuffle(text, rng(seed), 1);
      expect(out).toContain("const a = 1;\nconst b = 2;");
    }
  });

  it("标题行/列表行不参与交换", () => {
    const text = "## 第二章 资金来源决定项目成败。居民参与影响最终效果。后续各节展开论述。";
    for (let seed = 0; seed < 30; seed++) {
      expect(structuralSentenceShuffle(text, rng(seed), 1)).toBe(text);
    }
  });

  it("少于三句的段落不动", () => {
    const text = "资金来源决定项目成败。居民参与影响最终效果。";
    for (let seed = 0; seed < 30; seed++) {
      expect(structuralSentenceShuffle(text, rng(seed), 1)).toBe(text);
    }
  });

  it("可换段落在足量种子下确实动过（不是恒等函数）", () => {
    let moved = 0;
    for (let seed = 0; seed < 40; seed++) {
      if (structuralSentenceShuffle(CLEAN, rng(seed), 1) !== CLEAN) moved++;
    }
    expect(moved).toBeGreaterThan(5);
  });
});
