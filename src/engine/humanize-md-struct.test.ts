/**
 * v0.9.54（续）：紧凑 Markdown 结构行（表格 / 列表项 / 引用行）**不许被插空行**。
 *
 * ## 与围栏的区别
 *
 * 围栏块是「内容不许改」（代码是事实性内容），这里是「**内容照改、排版不许动**」——
 * 列表项是正文，该去味；但段落切分 `split(/\n+/)` + `join("\n\n")` 会把每个列表项
 * 都拉成独立段落，后果是：
 *   · 表格：表头与 `| --- |` 分隔行之间被塞进空行 ⇒ **GFM 表格直接失效**，
 *     渲染出来是一堆竖线文本；
 *   · 列表：紧凑列表变松散列表（CommonMark 下 `<li>` 各自包 `<p>`，行距全变）；
 *   · 引用：连续 `>` 行被拆成多个独立 blockquote。
 *
 * ## 断言纪律
 *
 * - 多种子 × 多强度扫描（是否替换取决于 rng 落点 + 强度档）。
 * - 判据写死为独立常量。
 * - 每条配反向断言：① 结构行**仍被去味**（不是整体冻结的假绿）；
 *   ② 普通段落之间**仍是 `\n\n`**（零回归）。
 */
import { describe, expect, it } from "vitest";
import { humanize } from "./humanize.ts";

const HEAD = "本次改造要点如下：";
const TAIL = "总的来看，本次改造风险可控。";

/** 紧凑无序列表（项间单换行） */
const LIST = ["- 首先，需要说明的是，接口层做了全面重构。", "- 其次，需要说明的是，缓存策略也一并调整。", "- 最后，需要说明的是，监控指标已补齐。"].join("\n");
/** 松散列表（作者自己加了空行）——必须保持双换行 */
const LIST_LOOSE = ["- 首先，需要说明的是，接口层做了全面重构。", "", "- 其次，需要说明的是，缓存策略也一并调整。"].join("\n");
/** GFM 表格：表头 + 分隔行 + 两行数据，四行必须连续 */
const TABLE = ["| 参数 | 说明 |", "| --- | --- |", "| timeout | 此外，需要说明的是，单位为毫秒 |", "| retry | 综上所述，最大重试次数为五 |"].join("\n");
/** 连续引用行 */
const QUOTE = ["> 此外，需要说明的是，本次方案在成本上具备优势。", "> 综上所述，建议按此方案推进。"].join("\n");

const SEEDS = [1, 7, 42, 20261015, 88888];
const LEVELS = [0.6, 0.9, 1];

describe("紧凑 Markdown 结构行：不许被插空行（v0.9.54 续）", () => {
  it("表格四行保持连续 —— 插一个空行 GFM 表格就失效了", () => {
    for (const intensity of LEVELS) {
      for (const seed of SEEDS) {
        const out = humanize(`${HEAD}\n\n${TABLE}\n\n${TAIL}`, { intensity, seed });
        // 表头与分隔行之间、分隔行与首行数据之间都不得出现空行
        expect(out.includes("| 参数 | 说明 |\n| --- | --- |"), `i=${intensity} seed=${seed} 表头/分隔行被拆`).toBe(true);
        expect(out.includes("| --- | --- |\n| timeout |"), `i=${intensity} seed=${seed} 分隔行/数据行被拆`).toBe(true);
      }
    }
  });

  it("无序列表项保持单换行（紧凑列表不许变松散列表）", () => {
    for (const intensity of LEVELS) {
      for (const seed of SEEDS) {
        const out = humanize(`${HEAD}\n\n${LIST}\n\n${TAIL}`, { intensity, seed });
        const lines = out.split("\n");
        const idx = lines.map((l, i) => (l.startsWith("- ") ? i : -1)).filter((i) => i >= 0);
        expect(idx.length, `i=${intensity} seed=${seed} 列表项数`).toBe(3);
        // 三个列表项必须是**连续**三行（中间无空行）——松散列表会让 <li> 各自包 <p>
        expect(idx[1] - idx[0], `i=${intensity} seed=${seed} 第 1/2 项之间`).toBe(1);
        expect(idx[2] - idx[1], `i=${intensity} seed=${seed} 第 2/3 项之间`).toBe(1);
      }
    }
  });

  it("连续引用行保持单换行（不许被拆成多个 blockquote）", () => {
    for (const intensity of LEVELS) {
      for (const seed of SEEDS) {
        const out = humanize(`${HEAD}\n\n${QUOTE}\n\n${TAIL}`, { intensity, seed });
        expect(out.includes("。\n> "), `i=${intensity} seed=${seed} 引用行被拆`).toBe(true);
      }
    }
  });

  it("作者自己写空行的松散列表 → 保持双换行（不许反过来压平）", () => {
    for (const seed of SEEDS) {
      const out = humanize(`${HEAD}\n\n${LIST_LOOSE}\n\n${TAIL}`, { intensity: 1, seed });
      expect(out.includes("。\n\n- "), `seed=${seed} 松散列表被压平`).toBe(true);
    }
  });

  it("反向断言①：结构行内容仍被去味（不是整块冻结的假绿）", () => {
    // 用有序列表：无序列表的「首先/其次/最后」是枚举骨架词，按设计保留
    // （v0.9.51 起这类句首结构标记在书面稿里不口语化），所以拿它当"引擎在动"的证据会假红。
    const ordered = ["1. 此外，需要说明的是，先完成数据迁移。", "2. 此外，需要说明的是，再切换流量开关。", "3. 此外，需要说明的是，最后下线旧链路。"].join("\n");
    let changed = 0;
    for (const seed of SEEDS) {
      const out = humanize(`${HEAD}\n\n${ordered}\n\n${TAIL}`, { intensity: 1, seed });
      if (out !== `${HEAD}\n\n${ordered}\n\n${TAIL}`) changed++;
      // 且编号不能被吃掉
      expect(out.split("\n").filter((l) => /^\d\. /.test(l)).length, `seed=${seed} 编号项数`).toBe(3);
    }
    expect(changed).toBeGreaterThan(0);
  });

  it("反向断言②：普通段落之间仍是 \\n\\n（零回归）", () => {
    for (const intensity of LEVELS) {
      for (const seed of SEEDS) {
        const out = humanize(`${HEAD}\n\n${TAIL}\n\n因此，我们认为该方案具备可行性。`, { intensity, seed });
        expect(out.split(/\n\n+/).filter((p) => p.trim()).length, `i=${intensity} seed=${seed} 段数`).toBe(3);
        expect(out.includes("\n\n\n"), `i=${intensity} seed=${seed} 三连换行`).toBe(false);
      }
    }
  });
});
