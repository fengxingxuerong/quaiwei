/**
 * 句法/标点完整性门禁（v0.9.67）
 *
 * 覆盖缺陷盘点里「切句破坏」那一类的**输出级不变量**——不依赖是哪个层造出来的，
 * 只看最终产出有没有这些形态：
 *   · 句末悬空连接词（「…成本也更低但。」）
 *   · 骨架词独立成句（「其次。」）
 *   · 枚举标记光杆（「一、」「2.」单独成句）
 *   · 句首残标点（「，另外…」）
 *   · 括号 / 引号不成对、交叉失序（「（甲」+「）」错位）
 *   · 空括号（「（）」）
 *   · 正文里出现连续空格（代码块的缩进不算——先屏蔽代码区间再判）
 *
 * 与 scan-bugs 的分工：那边是**生成侧**探针（构造语料逼出特定病句签名，共 20+ 条），
 * 这里是**产出侧**不变量（拿真实语料跑完全档位再回头验形态）。
 * 两者互补：生成侧能定位根因，产出侧能兜住没被探针覆盖的语料组合。
 *
 * ⚠️ 判据设计上的两条纪律（都是写这文件时踩出来的）：
 *   1. 先 `maskCodeSpans` 再判标点/空格——否则围栏块里的 4 空格缩进与 `ping()` 的空括号
 *      会被当成"正文连续空格 / 空括号"误报（实测 12 次假红）。
 *   2. 不判「半角逗号混排」：`injectHalfWidth` 是**有意的**反指纹特征（按概率把 ，换成 ,），
 *      判它会打自己的脸。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { humanize } from "./humanize";
import { maskCodeSpans } from "./text-shield";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 真实语料：直接读 realcase 的 23 篇夹具（它们覆盖 9 种体裁与全部结构形态） */
const CORPUS = (
  JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/realcase/cases.json"), "utf-8")) as {
    cases: { id: string; text: string }[];
  }
).cases;

const EXTRA = [
  {
    id: "Y1-骨架词密集",
    text: "首先要说明的是，本次改造覆盖三个模块。其次，缓存层做了重写。再次，网关层加了限流。最后，我们补了监控。",
  },
  {
    id: "Y2-枚举与连接词",
    text: "一是接口收敛，二是缓存统一，三是灰度发布。此外，值班手册同步更新，而监控口径也随之调整。",
  },
  {
    id: "Y3-引语与括号",
    text: "负责人表示：「本次升级不会影响存量用户（含企业版），具体时间另行通知。」随后，团队发布了迁移指南。",
  },
];

const LEVELS = [0.4, 0.6, 0.9];
const SEEDS = [7, 20260905];

const SENTENCE_SPLIT = /(?<=[。！？])/;
const sentencesOf = (t: string): string[] =>
  t
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean);

const stripEnd = (s: string) => s.replace(/[。！？…]+$/, "").trim();

/** 句末不许悬空连接词 */
const DANGLING_TAIL =
  /(?:但|而|且|并|然而|因此|所以|但是|而且|以及|或者|同时|另外|此外|还有|总之|于是)$/;
/** 骨架词独立成句 */
const SKELETON_ONLY = new Set([
  "首先",
  "其次",
  "再次",
  "最后",
  "另外",
  "此外",
  "总之",
  "综上",
  "综上所述",
  "总的来说",
  "总的说来",
  "其一",
  "其二",
  "其一，",
  "其二，",
]);
/** 光杆枚举标记 */
const ENUM_ONLY = /^[一二三四五六七八九十0-9]{1,3}[、.．)）]?$/;
/** 句首残标点 */
const LEAD_PUNCT = /^[，、；：]/;

const BRACKET_PAIRS: [string, string][] = [
  ["（", "）"],
  ["(", ")"],
  ["【", "】"],
  ["「", "」"],
  ["《", "》"],
  ["“", "”"],
];

function bracketProblems(text: string): string[] {
  const plain = maskCodeSpans(text).text; // 代码里的括号不参与判据
  const bad: string[] = [];
  const count = (s: string, ch: string) => s.split(ch).length - 1;
  for (const [open, close] of BRACKET_PAIRS) {
    const a = count(plain, open);
    const b = count(plain, close);
    if (a !== b) bad.push(`${open}${close} 不成对（${a}/${b}）`);
  }
  // 嵌套顺序：栈扫描，交叉即失序
  const openMap = new Map(BRACKET_PAIRS);
  const closeSet = new Set(BRACKET_PAIRS.map(([, c]) => c));
  const stack: string[] = [];
  for (const ch of plain) {
    if (openMap.has(ch)) stack.push(ch);
    else if (closeSet.has(ch)) {
      const want = openMap.get(stack[stack.length - 1] ?? "");
      if (want !== ch) {
        bad.push(`括号交叉/失序（遇到 ${ch}）`);
        return bad;
      }
      stack.pop();
    }
  }
  return bad;
}

/** 返回这一篇产出的形态违规（空数组 = 干净） */
function formProblems(out: string): string[] {
  const bad: string[] = [];
  for (const raw of sentencesOf(out)) {
    const body = stripEnd(raw);
    if (!body) continue;
    if (DANGLING_TAIL.test(body)) bad.push(`句末悬空连接词：${raw}`);
    if (SKELETON_ONLY.has(body)) bad.push(`骨架词独立成句：${raw}`);
    if (ENUM_ONLY.test(body)) bad.push(`枚举标记光杆：${raw}`);
    if (LEAD_PUNCT.test(body)) bad.push(`句首残标点：${raw}`);
  }
  bad.push(...bracketProblems(out));
  const plain = maskCodeSpans(out).text;
  if (/[（(]\s*[）)]/.test(plain)) bad.push("空括号");
  // 只在**行内**判连续空格（不把 \n 折成空格——那会把换行前后拼成假双空格）；
  // 单空格是排版习惯（"QPS 上限"），双空格才是痕迹。
  if (plain.split("\n").some((line) => /[^\s] {2,}[^\s]/.test(line))) bad.push("正文连续空格");
  return bad;
}

describe("句法/标点完整性（产出级不变量）", () => {
  for (const { id, text } of [...CORPUS, ...EXTRA]) {
    it(`${id}：全档位无句法形态缺陷`, () => {
      for (const intensity of LEVELS) {
        for (const seed of SEEDS) {
          const out = humanize(text, { intensity, seed });
          const bad = formProblems(out);
          expect(bad, `@${intensity} seed=${seed}\n  出：${out}`).toEqual([]);
        }
      }
    });
  }
});

describe("判据自测（防止判据过宽/过窄）", () => {
  it("能抓出各类形态缺陷", () => {
    expect(formProblems("成本也更低但。")).toContain("句末悬空连接词：成本也更低但。");
    expect(formProblems("其次。")).toContain("骨架词独立成句：其次。");
    expect(formProblems("一、。")).toContain("枚举标记光杆：一、。");
    expect(formProblems("，另外要说明。")).toContain("句首残标点：，另外要说明。");
    expect(formProblems("（甲）。").some((p) => p.includes("括号"))).toBe(false);
    expect(formProblems("（甲。").some((p) => p.includes("不成对"))).toBe(true);
    expect(formProblems("（甲】）。").some((p) => p.includes("失序"))).toBe(true);
    expect(formProblems("说明见（）。")).toContain("空括号");
    expect(formProblems("这里  有两个空格。")).toContain("正文连续空格");
  });

  it("不误伤：代码缩进与代码里的空括号不算正文缺陷", () => {
    const src = "示例：\n\n```js\nclient.ping();\n    if (ok) run();\n```\n";
    expect(formProblems(src)).toEqual([]);
  });
});
