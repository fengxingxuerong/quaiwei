import { describe, it, expect } from "vitest";
import { humanize } from "./humanize";
import { FORMAT_CORPUS, formatIssues, selftestDead } from "./format-integrity";

/**
 * 格式保真门禁（v0.9.81）
 *
 * 对应 `scripts/defect-taxonomy.ts` 的 **「格式损坏」** 类别。
 *
 * ## 与 `fidelity-guard.test.ts` 的分工
 *
 * 那边管**实体守恒**（URL/邮箱/时间/数字一个都不能少、不能改坏）；
 * 这里管**结构守恒**——围栏块逐字、表格行连续、列表项连续、标题层级序列、
 * setext 下划线贴住标题、结构行的续行不被空行拆开、缩进是语义。
 *
 * 两者合起来才是「格式损坏」这一类：少了字符是损坏，结构散了同样是损坏，
 * 而后者是形态正则（`scan-bugs.ts`）**天生看不见**的——它找的是「出现了坏形态」，
 * 找不到「结构被拆了」。
 *
 * ## 为什么判据本体不写在测试里
 *
 * 判据在 `format-integrity.ts`，因为批量实验（`npm run sweep:format`，
 * 17 语料 × 4 档 × 30 种子 × 2 管线）与这里必须**共用同一份判据**——
 * 否则「扫查全绿」与「测试全绿」可能说的是两件事（本项目吃过这个亏）。
 *
 * ## 本轮（v0.9.81）靠它抓到的两个活实例
 *
 * 都在用户路径 `humanize()` 上，**默认档 0.3 就中招**：
 *   ① 列表项续行被拉成独立段落、缩进被 trim ⇒ 紧凑列表变松散；
 *   ② setext 下划线被插空行拆开（下游结构层还会把它粘成 `标题一===`）。
 */

const INTENSITIES = [0.3, 0.6, 0.9, 1.0] as const;
const SEEDS = [0, 1, 2, 3, 4];

describe("格式保真门禁", () => {
  /**
   * 反向对照：每条判据都必须能被一份**故意弄坏**的产出触发。
   *
   * 没有这一条，上面那些 `expect(hits).toEqual([])` 可能是永真式
   * （判据写错了 → 永远不响 → 全绿）。
   * `fidelity-guard.test.ts` 的教训：三次「探针自己有 bug 却被当成引擎缺陷」。
   */
  it("23 条判据全都不是永真式（坏样本必须能触发）", () => {
    expect(selftestDead(), "这些判据喂坏样本也不响，等于没写").toEqual([]);
  });

  it("humanize：17 段格式语料 × 4 档 × 5 种子，结构不变式全部成立", () => {
    const hits: string[] = [];
    for (const [label, text] of FORMAT_CORPUS) {
      for (const intensity of INTENSITIES) {
        for (const seed of SEEDS) {
          const out = humanize(text, { intensity, seed });
          for (const i of formatIssues(text, out))
            hits.push(`${label}/i${intensity}/s${seed} ${i.rule}: ${i.detail}`);
        }
      }
    }
    expect(
      hits,
      `${hits.length} 处结构损坏（${FORMAT_CORPUS.length * INTENSITIES.length * SEEDS.length} 次运行）：\n  ${hits.slice(0, 8).join("\n  ")}`,
    ).toEqual([]);
  });

  /**
   * 两个缺陷的**专向**用例。
   *
   * 为什么单列：语料扫描里这两条只在特定语料上命中，而它们是本轮唯一的两个
   * 真实引擎缺陷——被修掉之后，要靠这两条盯住「别改回去」。
   */
  it("① setext 下划线必须紧贴标题行（不许被插空行，也不许被粘成「标题===」）", () => {
    const text = "标题一\n===\n\n正文一段。\n\n标题二\n---\n\n正文两段。";
    for (const intensity of INTENSITIES) {
      for (const seed of SEEDS) {
        const out = humanize(text, { intensity, seed });
        const where = `i${intensity}/s${seed}`;
        expect(out, `${where} 下划线离开了标题行：\n${out}`).toContain("标题一\n===");
        expect(out, `${where} 下划线离开了标题行：\n${out}`).toContain("标题二\n---");
        expect(out, `${where} 下划线被粘到标题尾巴上：\n${out}`).not.toContain("标题一===");
        expect(out, `${where} 下划线被粘到标题尾巴上：\n${out}`).not.toContain("标题二---");
      }
    }
  });

  it("② 结构行的续行必须紧贴它所属的结构行（缩进也是语义）", () => {
    const text = "- 第一项，后面跟一行没有标记的续行\n  续行内容与上一行同属一个列表项。\n- 第二项";
    for (const intensity of INTENSITIES) {
      for (const seed of SEEDS) {
        const out = humanize(text, { intensity, seed });
        const where = `i${intensity}/s${seed}`;
        // 续行不能被空行拆成独立段落（Markdown 语义：拆开就从紧凑列表变松散列表）
        expect(
          out.includes("- 第一项") && out.includes("\n\n  续行内容"),
          `${where} 续行被空行拆开：\n${out}`,
        ).toBe(false);
        // 缩进不能被 trim 掉（v0.9.65 给嵌套列表项修过同一个坑）
        const contLine = out.split("\n").find((l) => l.includes("续行内容与上一行"));
        expect(contLine, `${where} 续行整行丢了：\n${out}`).toBeTruthy();
        expect(contLine, `${where} 续行的两空格缩进被 trim：${JSON.stringify(contLine)}`).toMatch(
          /^ {2}续行内容与上一行/,
        );
      }
    }
  });
});
