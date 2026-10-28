/**
 * 格式保真判据（v0.9.81）
 *
 * 对应 `scripts/defect-taxonomy.ts` 的 **「格式损坏」** 类别。
 *
 * ## 为什么要有这一层（与签名正则的分工）
 *
 * `scan-bugs.ts` 的签名是**形态正则**——它找「出现了某个坏形态」。格式损坏的主形态
 * 恰恰相反，是「**结构被拆了**」：空行插进围栏、表格行的分隔被吃掉、列表项被拆断、
 * setext 下划线离开标题行。正则天生看不见「少了东西 / 结构散了」。
 *
 * 所以这里给的是**结构不变式**：拿原文与产出逐条对结构（围栏块逐字、表格行连续段、
 * 列表项连续段、标题层级序列、链接目标、URL/日期/时间集合……），
 * 允许正文被改写，不允许结构失效。
 *
 * ## 判据纪律（本项目踩过的坑，逐条内化）
 *
 * 1. **判据落在「结构是否还有效」，不落在「字节是否相等」**——表格单元格里的中文
 *    **应该**被改写，比的是「行是否连续、分隔行还在不在、列数守恒不守恒」。
 * 2. **每条判据都要能被反向对照触发**（`selftestDead()`）：把规则喂给一份**故意弄坏**
 *    的产出，规则不响就是永真式。`fidelity-guard.test.ts` 的教训是
 *    「三次探针自己有 bug 却被当成引擎缺陷」。
 * 3. **先锚定原文，再看产出**：第一版按「产出里第 i 与 i+2 行都是同类 → 中间不许空行」判，
 *    扫出 60 处假阳性——有序列表与紧随其后的无序列表**原文就隔着空行**（本就是两张列表）。
 *    改成「原文的连续段长度 == 产出的」后归零。
 * 4. **散文软换行不算损坏**：`humanize()` 对普通正文的既定口径是「一行一段」
 *    （`text.split(/\n+/)` + `join("\n\n")`，v0.9.54 注释写明），把软换行判成损坏
 *    会与设计打架；只有**结构行的续行**（`- 项⏎  续行`）被拆开才算缺陷。
 * 5. 段落数变化只记账、不进判据：段合并是引擎的明确设计行为（v0.9.24 已定）。
 *
 * ## 本轮（v0.9.81）靠它抓到的两个活实例
 *
 * 都在**用户路径 `humanize()`** 上，默认档 0.3 就中招：
 *   · 列表项续行被拉成独立段落并丢缩进 ⇒ 紧凑列表变松散；
 *   · setext 下划线被插空行拆开（下游结构层还会把它粘成 `标题一===`）。
 * 修法见 `humanize.ts` 的 段落层（续行/setext 沿用原文分隔符）+ `text-shield.ts`
 * 的 `isContinuationLine` / `isSetextUnderline` / `isSetextBlock`。
 */

import { fencedCodeSpans, frontmatterSpans, inlineCodeSpans } from "./text-shield.ts";

/** 语料：**专挑格式密集的形态**（普通中文散文在这里没意义） */
export const FORMAT_CORPUS: [string, string][] = [
  [
    "md-全套",
    [
      "---",
      "title: 项目周报",
      "date: 2026-10-26",
      "tags: [release, md]",
      "---",
      "",
      "# 本周进展",
      "",
      "本周主要围绕**结构保真**做收敛，涉及下表几处改动。",
      "",
      "## 改动清单",
      "",
      "| 模块 | 改动 | 影响面 |",
      "| --- | --- | --- |",
      "| 围栏冻结 | 整块跳过改写 | 代码不再被篡改 |",
      "| 表格 | 保留原文分隔符 | GFM 表格仍有效 |",
      "",
      "需要注意的顺序：",
      "",
      "1. 先跑 `npx tsx scripts/format-fidelity-sweep.ts`；",
      "2. 再看 `artifacts/format-fidelity/hits.json`；",
      "3. 最后读样本确认，别急着改引擎。",
      "",
      "- 无序项一：含行内代码 `const a = 1;`",
      "- 无序项二：含链接 [文档](./docs/README.md) 与锚点 [跳转](#下周计划)",
      "- 无序项三：含图片 ![架构图](./assets/arch.png)",
      "",
      "> 引用块第一行，用来验证连续引用不被拆成多个 blockquote。",
      "> 引用块第二行，同样不该被插空行。",
      "",
      "```ts",
      "",
      "// 此外，需要说明的是，块内空行与中文注释都必须原样保留",
      "const ok = !!value;",
      "const x = a ?? b;",
      "",
      "```",
      "",
      "接口地址 https://example.com/docs/api?id=42&v=2 ，更新于 2026-10-26 01:30 。",
      "",
      "参考 [GFM 规范](https://example.github.io/gfm/#tables-extension-) 与脚注[^1]。",
      "",
      "[^1]: 脚注定义行，同样不该被改写结构。",
      "",
      "## 下周计划",
      "",
      "下一阶段把相对路径链接（`./x.md`、`../y/z.ts`）也纳入判据。",
    ].join("\n"),
  ],
  [
    "md-紧凑无空行",
    [
      "# 调用说明",
      "接口地址变更为 https://api.example.com/v2/items ，旧地址将于 2026-12-31 停止服务。",
      "| 参数 | 类型 | 说明 |",
      "| :--- | :---: | ---: |",
      "| id | string | 必填 |",
      "| limit | number | 默认 20 |",
      "- 第一项：`id` 必填",
      "- 第二项：`limit` 默认 20",
      "> 注意：旧地址停止服务后不再返回数据。",
    ].join("\n"),
  ],
  [
    "裸代码无围栏",
    [
      "调用示例：",
      "",
      "const ok = !!value;",
      "const x = a ?? b;",
      "const re = /a{2,}/g;",
      "",
      "参数说明：`value` 可以是空值，`a` 与 `b` 都是布尔量。",
    ].join("\n"),
  ],
  [
    "缩进代码块",
    [
      "下面是一段缩进代码：",
      "",
      "    const a = 1;",
      "    // 此外，缩进本身是块身份，不能丢",
      "    console.log(a);",
      "",
      "缩进结束，回到正文。",
    ].join("\n"),
  ],
  [
    "html与标签",
    [
      '<div class="wrap">',
      "",
      "  这段正文在 div 里，应当照常去味。",
      "",
      '  <span data-x="1">行内标签</span> 也应当保留。',
      "",
      "</div>",
      "",
      '换行标签 <br/> 与自闭合 <img src="./a.png" alt="图"/> 一并保留。',
    ].join("\n"),
  ],
  [
    "url时间密集",
    [
      "迁移通告：原地址 https://old.example.com/a/b?x=1&y=2 于 2026-10-01 00:00 停用，",
      "新地址 https://new.example.com/v3/items#top 自 2026-10-01 08:30 起生效。",
      "邮箱 ops@example.com ，电话 13800138000 ，版本 v3.2.1 。",
      "",
      "```bash",
      "curl -X POST https://new.example.com/v3/items -H 'X-Token: abc' -d '{\"id\":1}'",
      "```",
      "",
      "详细说明见 www.example.com/guide 与 ./docs/migrate.md 。",
    ].join("\n"),
  ],
  [
    "引用与嵌套列表",
    [
      "> 外层引用第一行",
      "> 外层引用第二行",
      "> - 引用里的列表项一",
      "> - 引用里的列表项二",
      "",
      "- 顶层项",
      "  - 嵌套项一",
      "  - 嵌套项二",
      "- 顶层项二",
      "",
      "1. 有序项一",
      "2. 有序项二",
    ].join("\n"),
  ],
  [
    "changelog形态",
    [
      "## v0.9.81",
      "",
      "### 一、改动",
      "",
      "- `scripts/format-fidelity-sweep.ts`：新增结构不变式扫查；",
      "- `src/engine/text-shield.ts`：围栏冻结补空行形态。",
      "",
      "### 二、验证",
      "",
      "```text",
      "Test Files  117 passed (117)",
      "     Tests  2330 passed (2330)",
      "```",
      "",
      "详见 [CHANGELOG.md](./CHANGELOG.md#v0981)。",
    ].join("\n"),
  ],
  [
    "剧本与时间轴",
    [
      "【场景：会议室 内 日】",
      "【人物：林薇、店长】",
      "",
      "林薇：（翻着表格）这一列的数字对不上。",
      "店长：哪一列？",
      "",
      "【旁白】她停顿了两秒。",
      "",
      "时间轴：00:12 起稿 → 00:45 定稿 → 01:30 送审。",
    ].join("\n"),
  ],
  [
    "长表格与公式",
    [
      "下表是各档位的实测口径：",
      "",
      "| 档位 | 强度 | 段落数 | 备注 |",
      "| --- | --- | --- | --- |",
      "| 轻 | 0.3 | 6 | 只动最刺眼的 |",
      "| 中 | 0.6 | 6 | 默认档 |",
      "| 重 | 0.9 | 6 | 允许重排 |",
      "",
      "约定：`x >= 10` 且 `x <= 100` 时取中位数；公式 `a^2 + b^2 = c^2` 原样保留。",
    ].join("\n"),
  ],
  // —— 以下是对抗性形态：v0.9.54~65 的保护很可能没覆盖，专门用来找活实例 ——
  [
    "setext与分隔线",
    [
      "标题一",
      "===",
      "",
      "标题二",
      "---",
      "",
      "正文一段，写在两条分隔线之间。",
      "",
      "---",
      "",
      "分隔线之后还有一段正文。",
    ].join("\n"),
  ],
  [
    "任务清单与星号",
    [
      "- [ ] 未完成项",
      "- [x] 已完成项",
      "",
      "* 星号项一",
      "* 星号项二",
      "",
      "+ 加号项一",
      "+ 加号项二",
      "",
      "以上三种列表标记都应当原样保留。",
    ].join("\n"),
  ],
  [
    "两空格续行",
    [
      "- 第一项，后面跟一行没有标记的续行",
      "  续行内容与上一行同属一个列表项，中间不该被插空行。",
      "- 第二项",
      "",
      "正文段落，句子后面有一个软换行",
      "  第二行同样属于这一段。",
    ].join("\n"),
  ],
  [
    "围栏变体",
    [
      "~~~js",
      'console.log("a");',
      "~~~",
      "",
      "````md",
      "```",
      "嵌套围栏：外层四个反引号，内层三个",
      "```",
      "````",
      "",
      '```ts title="x.ts"',
      "const a = 1;",
      "```",
      "",
      "```ts",
      "未闭合围栏到文末为止",
    ].join("\n"),
  ],
  [
    "表格转义与内联",
    [
      "| 参数 | 说明 |",
      "| --- | --- |",
      "| `a\\|b` | 含转义竖线的单元格 |",
      "| [链接](https://x.cn/a?b=1) | 单元格里的链接 |",
      "",
      "转义竖线 `\\|` 不能被改写。",
    ].join("\n"),
  ],
  [
    "引用里的表格与围栏",
    [
      "> | a | b |",
      "> | --- | --- |",
      "> | 1 | 2 |",
      ">",
      "> ```sh",
      "> echo hi",
      "> ```",
      "",
      "引用块之后的正文。",
    ].join("\n"),
  ],
  [
    "HTML块与注释",
    [
      "<details>",
      "<summary>展开</summary>",
      "",
      "正文在 details 里面，应当照常去味。",
      "",
      "</details>",
      "",
      "<!-- 注释：不该被改写 -->",
      "",
      "自动链接 <https://example.com/a?b=1&c=2> 与参考式 [指南][g]。",
      "",
      "[g]: https://example.net/guide",
    ].join("\n"),
  ],
];

// ============================================================
// 判据
// ============================================================
const TABLE_ROW_RE = /^[ \t]*\|.*\|[ \t]*$/;
const TABLE_DELIM_RE = /^[ \t]*\|(?:[ \t]*:?-{1,}:?[ \t]*\|)+[ \t]*$/;
const LIST_ITEM_RE = /^([ \t]*)([-*+]|\d+[.)])[ \t]+\S/;
const QUOTE_RE = /^[ \t]*>/;
const HEADING_RE = /^(#{1,6})[ \t]+\S/;
/** setext 下划线（`===` / `---`）—— 它必须紧贴标题行，被插空行就不再是标题 */
const SETEXT_RE = /^(?:=+|-+)[ \t]*$/;
/** 任务清单勾选框 —— 被改写/丢掉，列表语义就没了 */
const TASK_ITEM_RE = /^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]*\S/;
/** 1~3 空格缩进的续行（列表项续行、段落软换行）——4 空格以上归缩进块 */
const CONT_LINE_RE = /^[ \t]{1,3}\S/;
const INDENTED_RE = /^(?: {4}|\t)\S/;
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;
const LINK_TARGET_RE = /!?\[[^\]]*\]\(([^)\s]+)(?:[ \t]+"[^"]*")?\)/g;
/** 引用式链接定义 `[id]: url`。**排除脚注** `[^1]: 说明`——它后面跟的是正文，不是链接目标 */
const LINK_REF_DEF_RE = /^[ \t]*\[(?!\^)[^\]]+\]:[ \t]*(\S+)/gm;
const AUTOLINK_RE = /<(https?:\/\/[^>\s]+)>/g;
const URL_RE = /https?:\/\/[!-~]+/g;
const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g;
const TIME_RE = /\d{1,2}:\d{2}/g;
const DATE_RE = /\d{4}-\d{2}-\d{2}/g;
const BOLD_MARK_RE = /\*\*/g;

const trim = (s: string) => (s.length > 34 ? s.slice(0, 34) + "…" : s);
const uniqSort = (a: string[]) => Array.from(new Set(a)).sort().join("|");

export interface FormatIssue {
  rule: string;
  detail: string;
}

/** 主判据：原文 → 产出，返回结构违规明细 */
export function formatIssues(input: string, out: string): FormatIssue[] {
  const issues: FormatIssue[] = [];
  const push = (rule: string, details: string[]) => {
    for (const d of details.slice(0, 3)) issues.push({ rule, detail: d });
  };
  const inLines = input.split("\n");
  const outLines = out.split("\n");

  // ① 围栏块：整块逐字保留（含开口/闭合行与块内空行）
  const fences = fencedCodeSpans(input);
  for (const f of fences) {
    const block = input.slice(f.start, f.end);
    if (!out.includes(block)) {
      push("围栏块逐字保留", [
        `块不再逐字出现（${block.length} 字符）：${trim(block.replace(/\n/g, "⏎"))}`,
      ]);
    }
  }

  // ② 行内代码：逐字保留（围栏内部的反引号不算——那里已由 ① 覆盖）
  const inline = inlineCodeSpans(input).filter(
    (s) => !fences.some((f) => s.start >= f.start && s.end <= f.end),
  );
  for (const s of inline) {
    const code = input.slice(s.start, s.end);
    if (!out.includes(code)) push("行内代码逐字保留", [`\`${trim(code)}\` 丢失或被改写`]);
  }

  // ③ frontmatter：整块逐字保留
  for (const f of frontmatterSpans(input)) {
    const block = input.slice(f.start, f.end);
    if (!out.includes(block)) push("frontmatter 逐字保留", [trim(block.replace(/\n/g, "⏎"))]);
  }

  // ④ 链接目标 / 引用定义 / 自动链接：不得丢失或改写
  const targets = [
    ...Array.from(input.matchAll(LINK_TARGET_RE), (m) => m[1]),
    ...Array.from(input.matchAll(LINK_REF_DEF_RE), (m) => m[1]),
    ...Array.from(input.matchAll(AUTOLINK_RE), (m) => m[1]),
  ];
  for (const t of targets) {
    if (!out.includes(t)) push("链接目标不得改写", [`链接目标「${t}」在产出里找不到`]);
  }

  // ⑤ URL / 邮箱 / 时间 / 日期：集合守恒
  for (const [kind, re] of [
    ["URL", URL_RE],
    ["邮箱", EMAIL_RE],
    ["时间", TIME_RE],
    ["日期", DATE_RE],
  ] as const) {
    const clean = (s: string) => s.replace(/[，。；：、）】」』"，]+$/, "");
    const a = uniqSort((input.match(re) ?? []).map(clean));
    const b = uniqSort((out.match(re) ?? []).map(clean));
    if (a !== b) push(`${kind}集合守恒`, [`原文 ${a.slice(0, 60)} → 产出 ${b.slice(0, 60)}`]);
  }

  // ⑥ HTML 标签：集合守恒
  const tagsIn = uniqSort(input.match(HTML_TAG_RE) ?? []);
  const tagsOut = uniqSort(out.match(HTML_TAG_RE) ?? []);
  if (tagsIn !== tagsOut) push("HTML 标签守恒", [`原文 ${tagsIn} → 产出 ${tagsOut}`]);

  // ⑦ 标题层级序列：层级与顺序守恒（文字可改）
  const levels = (ls: string[]) =>
    ls
      .map((l) => HEADING_RE.exec(l)?.[1])
      .filter(Boolean)
      .join(",");
  if (levels(inLines) !== levels(outLines)) {
    push("标题层级序列守恒", [`原文 [${levels(inLines)}] → 产出 [${levels(outLines)}]`]);
  }

  // ⑦b 软结构三件：setext 下划线 / 任务清单勾选框 / 结构行的续行
  const counted = (ls: string[], f: (i: number) => boolean) => ls.filter((_, i) => f(i)).length;
  const setextCount = (ls: string[]) =>
    counted(
      ls,
      (i) =>
        i > 0 && SETEXT_RE.test(ls[i]) && ls[i - 1].trim() !== "" && !SETEXT_RE.test(ls[i - 1]),
    );
  if (setextCount(inLines) !== setextCount(outLines)) {
    push("setext 下划线不许被拆", [
      `原文 ${setextCount(inLines)} 处 → 产出 ${setextCount(outLines)} 处`,
    ]);
  }

  const taskIn = inLines.filter((l) => TASK_ITEM_RE.test(l)).length;
  const taskOut = outLines.filter((l) => TASK_ITEM_RE.test(l)).length;
  if (taskIn !== taskOut) push("任务清单勾选框守恒", [`原文 ${taskIn} 项 → 产出 ${taskOut} 项`]);

  /**
   * 续行判据**只针对锚在结构行上的续行**（`- 项⏎  续行`）。
   *
   * 为什么必须锚定、且不管散文软换行：
   *   · `humanize()` 对普通正文的既定口径是「一行一段」——中文粘贴稿里
   *     「每段缩进两格、段间没有空行」极常见（12 样本的 N0 叙事稿就是），
   *     把这种软换行判成损坏会扫出与设计打架的假阳性；
   *   · 只有**往回穿过连续续行后落在结构行上**的续行才必须紧贴——
   *     被空行拆开后 Markdown 语义真的变了（紧凑列表变松散）。
   * 判据与引擎侧 `humanize.ts` 的 `structFamily` 必须同源，否则两边各说各话。
   */
  const isStructLead = (l: string): boolean =>
    LIST_ITEM_RE.test(l) ||
    TABLE_ROW_RE.test(l) ||
    QUOTE_RE.test(l) ||
    HEADING_RE.test(l) ||
    INDENTED_RE.test(l);
  const anchoredToStruct = (ls: string[], i: number): boolean => {
    let j = i - 1;
    // 回穿连续的续行：`- 项 / 续行 / 续行2` 里的两条续行都锚在同一个列表项上
    while (j >= 0 && CONT_LINE_RE.test(ls[j])) j--;
    return j >= 0 && isStructLead(ls[j]);
  };
  const contIn = counted(
    inLines,
    (i) => CONT_LINE_RE.test(inLines[i]) && anchoredToStruct(inLines, i),
  );
  const contOut = counted(
    outLines,
    (i) => CONT_LINE_RE.test(outLines[i]) && anchoredToStruct(outLines, i),
  );
  if (contIn !== contOut)
    push("结构行的续行不许被空行拆开", [`原文 ${contIn} 处 → 产出 ${contOut} 处`]);

  // ⑧ 表格：分隔行还在 + 行连续段长度守恒（插空行会拆段）+ 列数守恒
  const delimCount = (ls: string[]) => ls.filter((l) => TABLE_DELIM_RE.test(l)).length;
  if (delimCount(inLines) !== delimCount(outLines)) {
    push("表格分隔行不丢", [`原文 ${delimCount(inLines)} 条 → 产出 ${delimCount(outLines)} 条`]);
  }
  const pipes = (l: string) => (l.match(/\|/g) ?? []).length;
  const tableRowsIn = inLines.filter((l) => TABLE_ROW_RE.test(l) && !TABLE_DELIM_RE.test(l));
  const tableRowsOut = outLines.filter((l) => TABLE_ROW_RE.test(l) && !TABLE_DELIM_RE.test(l));
  if (tableRowsOut.length < tableRowsIn.length) {
    push("表格行列数守恒", [
      `表头+数据行 原文 ${tableRowsIn.length} → 产出 ${tableRowsOut.length}`,
    ]);
  } else {
    for (let i = 0; i < tableRowsIn.length; i++) {
      if (pipes(tableRowsIn[i]) !== pipes(tableRowsOut[i])) {
        push("表格列数守恒", [
          `第 ${i + 1} 行竖线数 ${pipes(tableRowsIn[i])} → ${pipes(tableRowsOut[i])}：${trim(tableRowsIn[i])} → ${trim(tableRowsOut[i])}`,
        ]);
        break;
      }
    }
  }

  // ⑨⑩⑪ 连续段守恒：**只在原文里本来就连续的行，产出里必须仍然连续**。
  //
  // ⚠️ 第一版按「产出里第 i 与 i+2 行都是同类 → 中间不许空行」判，扫出 60 处假阳性：
  // 有序列表与紧随其后的无序列表**原文就隔着空行**（两张不同的列表），被判成「被插空行」。
  // 改成「原文的连续段长度 == 产出的」：插空行会拆段、丢行会缩短、粘连会变长。
  const runsOf = (ls: string[], keyOf: (l: string) => string | null): string => {
    const runs: number[] = [];
    let cur: string | null = null;
    let n = 0;
    for (const l of ls) {
      const k = keyOf(l);
      if (k && k === cur) {
        n++;
        continue;
      }
      if (n > 0) runs.push(n);
      cur = k;
      n = k ? 1 : 0;
    }
    if (n > 0) runs.push(n);
    return runs.join(",");
  };
  const RUN_KINDS: [string, (l: string) => string | null][] = [
    ["表格行连续段守恒", (l) => (TABLE_ROW_RE.test(l) ? "T" : null)],
    [
      "列表项连续段守恒",
      (l) => {
        const m = LIST_ITEM_RE.exec(l);
        if (!m) return null;
        const ordered = /\d/.test(m[2]) ? "N" : m[2];
        return `${m[1].length}|${ordered}`;
      },
    ],
    ["引用行连续段守恒", (l) => (QUOTE_RE.test(l) ? "Q" : null)],
    ["行首标记连续段守恒", (l) => (HEADING_RE.test(l) ? "H" : null)],
    ["缩进行连续段守恒", (l) => (INDENTED_RE.test(l) ? "I" : null)],
  ];
  for (const [rule, keyOf] of RUN_KINDS) {
    const a = runsOf(inLines, keyOf);
    const b = runsOf(outLines, keyOf);
    if (a !== b) push(rule, [`原文段长 [${a}] → 产出 [${b}]`]);
  }

  // 缩进块：每行**连缩进一起**逐字保留
  for (const l of inLines.filter((l) => INDENTED_RE.test(l))) {
    if (!out.includes(l)) push("缩进块逐字保留", [`行「${trim(l)}」的缩进或内容变了`]);
  }

  // 强调标记：`**` 成对数量守恒
  const boldIn = (input.match(BOLD_MARK_RE) ?? []).length;
  const boldOut = (out.match(BOLD_MARK_RE) ?? []).length;
  if (boldIn !== boldOut) push("强调标记守恒", [`** 数 原文 ${boldIn} → 产出 ${boldOut}`]);

  return issues;
}

// ============================================================
// 判据自检：每条规则都要能被一份**故意弄坏**的产出触发，否则它是永真式
// ============================================================
export const SELFTEST_CASES: [string, string, string][] = [
  // [规则名, 原文, 被弄坏的产出]
  ["围栏块逐字保留", "a\n\n```ts\nconst a = 1;\n```\n", "a\n\n```ts\n\nconst a = 1;\n```\n"],
  ["行内代码逐字保留", "见 `const a = 1;` 这行。", "见 const a = 1; 这行。"],
  ["frontmatter 逐字保留", "---\ntitle: X\n---\n\n正文", "---\n\ntitle: X\n\n---\n\n正文"],
  ["链接目标不得改写", "见 [文档](./docs/README.md)。", "见 [文档](./docs/readme.md)。"],
  ["URL集合守恒", "见 https://a.cn/p?x=1 。", "见 https://a.cn/p 。"],
  ["邮箱集合守恒", "联系 a@b.com 。", "联系 a@b.cn 。"],
  ["时间集合守恒", "会议 09:30 开始。", "会议 9 点半开始。"],
  ["日期集合守恒", "更新于 2026-10-26 。", "更新于 2026年10月26日 。"],
  ["HTML 标签守恒", '<div class="x">正文</div>', "<div>正文</div>"],
  ["标题层级序列守恒", "# 一\n\n## 二\n", "一\n\n二\n"],
  ["setext 下划线不许被拆", "标题\n---\n\n正文", "标题\n\n---\n\n正文"],
  ["任务清单勾选框守恒", "- [ ] 未完成\n- [x] 完成", "- 未完成\n- 完成"],
  ["结构行的续行不许被空行拆开", "- 第一项\n  续行内容", "- 第一项\n\n  续行内容"],
  ["表格分隔行不丢", "| a | b |\n| --- | --- |\n| 1 | 2 |", "| a | b |\n| 1 | 2 |"],
  ["表格行列数守恒", "| a | b |\n| --- | --- |\n| 1 | 2 |", "| a | b |\n| --- | --- |"],
  [
    "表格列数守恒",
    "| a | b |\n| --- | --- |\n| 1 | 2 |",
    "| a | b |\n| --- | --- |\n| 1 | 2 | 3 |",
  ],
  [
    "表格行连续段守恒",
    "| a | b |\n| --- | --- |\n| 1 | 2 |",
    "| a | b |\n| --- | --- |\n\n| 1 | 2 |",
  ],
  ["列表项连续段守恒", "- 一\n- 二\n", "- 一\n\n- 二\n"],
  ["引用行连续段守恒", "> 一\n> 二\n", "> 一\n\n> 二\n"],
  ["行首标记连续段守恒", "# 一\n## 二\n", "# 一\n\n## 二\n"],
  ["缩进行连续段守恒", "    a = 1;\n    b = 2;", "    a = 1;\n\n    b = 2;"],
  ["缩进块逐字保留", "    const a = 1;", "const a = 1;"],
  ["强调标记守恒", "这是**加粗**的。", "这是加粗的。"],
];

/** 返回**没能被触发**的规则（空数组 = 23 条判据全都不是永真式） */
export function selftestDead(): string[] {
  const dead: string[] = [];
  for (const [rule, input, out] of SELFTEST_CASES) {
    if (!formatIssues(input, out).some((i) => i.rule === rule)) {
      dead.push(`${rule}（坏样本：${trim(out.replace(/\n/g, "⏎"))}）`);
    }
  }
  return dead;
}
