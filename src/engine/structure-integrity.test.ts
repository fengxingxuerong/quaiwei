/**
 * 结构完整性门禁（v0.9.65）
 *
 * 为什么单独开一条线：`defect-taxonomy.test.ts` 的盘点里，「格式损坏」是**从未修过**的
 * 两类之一。而 2026-10-23 一天内实测撞出四处，全部落在这个类里：
 *   1. 行内代码 `` `a ?? b` `` → `` `a ??b` ``（切句层把 `??` 当句末标点，后半段前导空格被 trim）
 *   2. 围栏块内空行 → 闭合围栏被粘到代码末行（下游 split(/\n\n+/) 把代码块劈成两段）
 *   3. 同时有 frontmatter 与围栏块时，**两者都失去冻结**（spanGuard 收到无序区间表）
 *   4. `- [x] 内容` 的空格被吃（GFM 任务项降级）、`  - 子项` 的缩进被 trim（嵌套被压平）
 *
 * 这里把「结构资产的逐字保真」变成可执行判据：围栏块 / frontmatter / 行内代码 / URL /
 * 数字 / 列表标记 / 表格竖线 / 引用行 / 空行，跨强度与种子扫一遍。
 * 与 realcase 的区别：那边判「产出像不像人写的」，这边只判「结构有没有被改坏」——
 * 后者是发布硬门槛，前者是质量信号。
 */
import { describe, expect, it } from "vitest";
import { humanize } from "./humanize";
import { frontmatterSpans, fencedCodeSpans, isCodeLikeLine } from "./text-shield";

const PROSE =
  "值得注意的是，随着人工智能技术的不断发展，数字化办公已成为大势所趋。综上所述，这一变革极大地提升了工作效率。";

/** 结构语料：每一篇都带一种「不能改坏」的结构资产 */
const FIXTURES: { name: string; text: string }[] = [
  {
    name: "markdown 表格",
    text: [
      "| 指标 | 2025 | 2026 |",
      "|---|---|---|",
      "| 营收 | 32.68 亿 | 41.20 亿 |",
      "| 增速 | 21.4% | 26.1% |",
    ].join("\n"),
  },
  {
    name: "任务列表 + 嵌套列表",
    text: [
      "- [ ] 梳理接口清单（37 个）",
      "- [x] 改造缓存层",
      "  - Redis 7.2 集群",
      "  - 淘汰策略 LFU",
    ].join("\n"),
  },
  {
    name: "引用块",
    text: ["> 合规成本的上升会淘汰投机者。", "> 也会让真正有场景积累的团队拿到窗口期。"].join("\n"),
  },
  {
    name: "frontmatter + 围栏块",
    text: [
      "---",
      "title: 项目周报",
      "date: 2026-10-23",
      "---",
      "",
      PROSE,
      "",
      "```js",
      "const a = 1;",
      "```",
    ].join("\n"),
  },
  {
    name: "行内代码（含 ?? / :: / ;）",
    text: "写法是 `a ?? b`，也有 `x::y` 与 `f(a; b)`；注意 `p ? q : r` 的优先级。",
  },
  {
    name: "链接与邮箱",
    text: "详见 https://example.com/a?b=1&c=2#frag 或 docs/x.md；联系 dev@example.com。",
  },
  {
    name: "数字与单位",
    text: "营收 32.68 亿元，同比 21.4%；净利 4.27 亿元；共 37 个接口，耗时 180ms。",
  },
  { name: "HTML 标签", text: "第一行<br>第二行，<b>重点</b>内容，<code>a ?? b</code> 结束。" },
  {
    name: "CRLF 输入",
    text: ["第一段文字，正常结束。", "", "第二段文字，正常结束。"].join("\r\n"),
  },
];

const LEVELS = [0.4, 0.6, 0.9];
const SEEDS = [7, 20260905];

/* ----------------------------- 结构提取器 ----------------------------- */

const fenceBlocks = (s: string): string[] => fencedCodeSpans(s).map((x) => s.slice(x.start, x.end));
const frontmatterBlocks = (s: string): string[] =>
  frontmatterSpans(s).map((x) => s.slice(x.start, x.end));
const inlineCodes = (s: string): string[] =>
  [...s.matchAll(/(`{1,2})([^`\n]*?)\1/g)].map((m) => m[0]).sort();
const urls = (s: string): string[] =>
  (s.match(/(?:https?:\/\/|www\.)[!-~]+|[\w.+-]+@[\w.-]+\.\w+/g) ?? []).slice().sort();
const numbers = (s: string): string[] => (s.match(/\d+(?:\.\d+)?%?/g) ?? []).slice().sort();
/** 列表标记连同缩进一起取——嵌套层级就写在缩进里，压平了必须红 */
const listMarkers = (s: string): string[] =>
  (s.match(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+(?:\[[ xX]\][ \t]+)?/gm) ?? []).map((x) => x);
const tableShapes = (s: string): string[] =>
  (s.match(/^\|.*\|$/gm) ?? []).map((l) => String((l.match(/\|/g) ?? []).length));
const quoteLines = (s: string): number => (s.match(/^>[ \t]?/gm) ?? []).length;

/** 一组「结构资产逐字保真」判据；返回被违反的判据名 */
function violations(input: string, output: string): string[] {
  const bad: string[] = [];
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!eq(fenceBlocks(input), fenceBlocks(output))) bad.push("围栏块被改动");
  if (!eq(frontmatterBlocks(input), frontmatterBlocks(output))) bad.push("frontmatter 被改动");
  if (!eq(inlineCodes(input), inlineCodes(output))) bad.push("行内代码被改动");
  if (!eq(urls(input), urls(output))) bad.push("URL / 邮箱被改动");
  if (!eq(numbers(input), numbers(output))) bad.push("数字集合被改动");
  if (!eq(listMarkers(input), listMarkers(output))) bad.push("列表标记或缩进被改动");
  if (!eq(tableShapes(input), tableShapes(output))) bad.push("表格行竖线数被改动");
  if (quoteLines(input) !== quoteLines(output)) bad.push("引用行数被改动");
  if (output.includes("\r")) bad.push("输出出现裸 CR");
  return bad;
}

describe("结构完整性（格式损坏类）", () => {
  for (const { name, text } of FIXTURES) {
    for (const intensity of LEVELS) {
      it(`${name} @${intensity}：结构资产逐字保真`, () => {
        for (const seed of SEEDS) {
          const out = humanize(text, { intensity, seed });
          const bad = violations(text, out);
          expect(
            bad,
            `seed=${seed} 违反：${bad.join(" / ")}\n  入：${JSON.stringify(text)}\n  出：${JSON.stringify(out)}`,
          ).toEqual([]);
        }
      });
    }
  }
});

/**
 * 下列四条是上面扫描覆盖到的**具体缺陷**的定点回归（失败时报错更直白，
 * 也防止有人把扫描表的某个 fixture 删掉后悄悄失去覆盖）。
 */
describe("格式损坏定点回归（v0.9.65）", () => {
  const opts = { intensity: 0.9, seed: 7 } as const;

  it("嵌套列表的缩进不被 trim（二级不许压平成一级）", () => {
    const src = [
      "- 一级条目，正常内容。",
      "  - 二级条目，属于上一项。",
      "    - 三级条目，更细一层。",
    ].join("\n");
    const out = humanize(src, opts);
    expect(out).toContain("  - 二级条目");
    expect(out).toContain("    - 三级条目");
  });

  it("GFM 任务项 `[x] ` 后的空格保留（丢了空格就不再是任务项）", () => {
    const src = ["上一段说明文字，先交代背景。", "", "- [x] 改造缓存层", "- [ ] 梳理接口清单"].join(
      "\n",
    );
    const out = humanize(src, opts);
    expect(out).toContain("- [x] 改造缓存层");
    expect(out).toContain("- [ ] 梳理接口清单");
  });

  it("引注 `[1] 说明` 的空格保留（不许把序号粘进正文）", () => {
    const src = "先说一句铺垫的话，然后再往下讲。见附录 [1] 的说明与 [2] 的补充。";
    const out = humanize(src, opts);
    expect(out).toContain("[1] 的说明");
  });

  it("同时有 frontmatter 与围栏块时，两者都逐字保留", () => {
    const fm = ["---", "title: 项目周报", "date: 2026-10-23", "---"].join("\n");
    const fence = "```js\nconst a = 1;\n```";
    const src = [fm, "", PROSE, "", fence].join("\n");
    const out = humanize(src, opts);
    expect(out).toContain(fm);
    expect(out).toContain(fence);
  });

  /**
   * v0.9.65：**没有围栏的代码片段**（中文技术文档里最常见的那种：从 Word / 公众号
   * 复制过来，「调用示例：」下面直接跟两行代码）必须同样冻结。
   * 修前实测：`const ok = !!value;` → `const ok = ，value;`（强度 0.6 默认档就中招），
   * `const x = a ?? b;` → `const x = a 。b;`（0.9），且行间被插空行（段落数 5 → 6）。
   */
  describe("裸代码行（无围栏）", () => {
    const snippets: [string, string][] = [
      [
        "js",
        'const ok = !!value;\nconst x = a ?? b;\nif (!resp.ok) throw new Error("gateway 5xx");',
      ],
      ["shell", "cd /opt/app\nnpm ci --omit=dev\nsystemctl restart app"],
      ["python", "def run(x):\n    return x > 0 && x < 10"],
      ["sql", "SELECT id, name FROM users\nWHERE id > 100 AND status = 'active'"],
    ];
    for (const [lang, code] of snippets) {
      it(`${lang} 片段：强度 0.6 / 0.9 下逐字保留，且行间不插空行`, () => {
        const src = [PROSE, "", "调用示例：", "", code, "", PROSE].join("\n");
        for (const intensity of [0.6, 0.9]) {
          const out = humanize(src, { intensity, seed: 7 });
          expect(out, `@${intensity} 代码被改写`).toContain(code);
        }
      });
    }

    it("URL 密集的说明句不被误判成代码（否则整行损失去味）", () => {
      const line =
        "接口地址变更为 https://api.example.com/v2/gateway，旧地址将于 2026-12-31 停止服务。技术对接请联系 dev-support@example.com。";
      const src = [PROSE, "", line, "", PROSE].join("\n");
      const out = humanize(src, opts);
      expect(isCodeLikeLine(line), "URL 说明句被判成代码（假阳性）").toBe(false);
      // 该行仍参与去味：逗号被切成分句（只要有变化即可，不锁具体改法）
      expect(out).not.toBe(src);
      expect(out).toContain("api.example.com/v2/gateway");
    });

    it("代码行判定不误伤正文（行首恰好是英文关键字的句子）", () => {
      for (const line of [
        "本次升级把平均响应时间压到 42ms，命中率提升到 94.7%。",
        "SELECT 语句的执行计划需要重点优化，否则查询会全表扫描。",
        "值得注意的是，if 条件分支过多会让代码难以维护。",
        "该方案在 2026 年第三季度落地，覆盖 37 个接口。",
      ]) {
        expect(isCodeLikeLine(line), `正文被误判成代码：${line}`).toBe(false);
      }
    });
  });
});
