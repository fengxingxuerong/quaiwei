/**
 * 数字保真守卫（v0.9.75 起，v0.9.79 改成「数值+量纲」比对）
 *
 * 为什么要有：LLM 改写最常见的**内容失真**不是"写错数字"，而是**整句连数字一起删掉**。
 * 2026-10-24 的三体裁 × 五模型实测就抓到一次（deepseek-v4-flash · 财经快讯）：
 *
 *   原文：「报告期末，公司总资产达到 126.75 亿元，较上年末上升 6.3%，资产负债率维持在 41.2%……」
 *   产出：整句消失 —— 126.75 与 6.3% 两个数字直接没了，其余数字都在。
 *
 * 这类丢失在"财报/公文/招标"场景里是硬伤（读者据此开会）。所以这里做**确定性**检查。
 *
 * ## 判据演进（每一版都是被真实数据推翻过才改的）
 *
 * v0.9.75 比字符串 → 被扫查工具打回：型号 `X200` 被当成数量、「3 个」↔「三个」被判丢事实。
 * v0.9.76 只收「数量型」 → 假阳性 3→0（24 次真实产出），真命中仍在。
 * v0.9.78 加**量纲**：`126.75 亿元` → `126.75 万元` 量级差 10000 倍，比数字错更隐蔽。
 * v0.9.79 改成**数值 + 量纲**比对，并用 chinese-numerals 解析中文数字：
 *   · `3 个` 与 `三个` 现在是同一个事实（此前只能把单个数字整体丢掉，白白损失灵敏度）；
 *   · `14 小时` 与 `十四小时` 同样互认。
 *
 * ## 设计边界（都是有意的）
 *
 *  - 只查数量（数字/百分数/带单位的量），**不查人名与机构名**——中文实体的同义改写边界太模糊，
 *    误报率压不住，而一次误报就会让人从此忽略这条提示；
 *  - **中文数字必须带单位才算事实**：单字「一」在中文里太像虚词（一方面/一致性/统一）；
 *  - 只报不拦（默认）：由调用方决定是写 note 还是回退原稿；
 *  - 纯函数、零依赖、确定性——不消耗任何 API 调用。
 */
import { parseChineseNumber, canonNumber } from "./chinese-numerals";

/** 一个数量事实：数值 + 归一后的量纲（无单位为空串，百分数记为 %） */
export interface QuantityFact {
  value: string;
  unit: string;
}

/**
 * 量纲单位（strict）：这些**必须连同数值一起保留**，改了就改变含义。
 *
 * 刻意**不含**量词（个/项/类/种/条/份/名/位/家/人/次/台/套/户/成/度）：
 * 实测回放（53 次真实产出）里，`一种方法 → 一个方法`、`两个方面 → 两方面` 这类
 * 量词替换占了全部"报警"的绝大多数——它们是**合法改写**，不是数据失真。
 * 把量词纳入检查会让这条提示变成噪音，用户从此不再看它。
 */
const UNITS = [
  "个百分点",
  "百分点",
  "亿元",
  "万元",
  "亿",
  "万",
  "千",
  "百",
  "小时",
  "分钟",
  "秒",
  "倍",
  "GB",
  "MB",
  "TB",
  "KB",
  "GHz",
  "MHz",
  "Wh",
  "W",
  "V",
  "A",
  "mA",
  "℃",
  "千克",
  "公斤",
  "克",
  "吨",
  "公里",
  "千米",
  "厘米",
  "毫米",
  "米",
  "升",
  "毫升",
];

/** 单位归一：同量纲的不同写法不该判错 */
function normUnit(u: string): string {
  if (u === "亿元") return "亿";
  if (u === "万元") return "万";
  if (u === "百分点") return "个百分点";
  if (u === "千米") return "公里";
  if (u === "千克" || u === "公斤") return "kg";
  return u;
}

const ARABIC_RE = new RegExp(`(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*(%|${UNITS.join("|")})?`, "g");
const CHINESE_RE = new RegExp(
  `([零〇一二三四五六七八九十百千万亿两]+(?:点[零〇一二三四五六七八九]+)?)\\s*(${UNITS.join("|")})`,
  "g",
);

function normalizeText(text: string): string {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．]/g, ".")
    .replace(/[％]/g, "%")
    .replace(/[，]/g, ",");
}

/**
 * 抽取数量事实。
 *
 * 收与不收（每条都对应一个真实反例）：
 *   ✓ 带单位的数字（`3 个` / `十四小时` / `126.75 亿元`）——中文数字也认
 *   ✓ 多位数、小数、百分数（`2025` / `12.7%` / `3.87`）
 *   ✗ 紧跟在 ASCII 字母后的数字（`X200` / `iPhone15` / `5G` / `Wi-Fi 7` 是标识符）
 *   ✗ 无单位的单个阿拉伯数字（`3` 太容易是编号/序号）
 */
export function quantityFacts(text: string): QuantityFact[] {
  const norm = normalizeText(text);
  const out: QuantityFact[] = [];

  ARABIC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ARABIC_RE.exec(norm)) !== null) {
    const raw = m[1].replace(/,/g, "");
    const before = norm.slice(Math.max(0, m.index - 1), m.index);
    if (/[A-Za-z]/.test(before)) continue; // 标识符：X200 / iPhone15
    const unit = m[2] ? normUnit(m[2] === "%" ? "%" : m[2]) : "";
    const isQuantity = unit !== "" || /\./.test(raw) || raw.length >= 2;
    if (!isQuantity) continue; // 无单位的单个数字
    out.push({ value: canonNumber(Number(raw)), unit });
  }

  CHINESE_RE.lastIndex = 0;
  while ((m = CHINESE_RE.exec(norm)) !== null) {
    const n = parseChineseNumber(m[1]);
    if (n === null) continue;
    out.push({ value: canonNumber(n), unit: normUnit(m[2]) });
  }
  return out;
}

/** 去重后的数值列表（保留旧接口：有些地方只关心"有哪些数"） */
export function quantitativeFacts(text: string): string[] {
  return [...new Set(quantityFacts(text).map((f) => f.value))].sort();
}

/** 数字原样串（最早期接口，含型号等一切数字；仅测试与调试用） */
export function numericFacts(text: string): string[] {
  const norm = normalizeText(text);
  const out = new Set<string>();
  for (const m of norm.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?%?/g)) out.add(m[0].replace(/,/g, ""));
  return [...out].sort();
}

/**
 * 原文有、产出里**找不到**的数量事实（按 数值+量纲 比）。
 *
 * 量纲缺失也算缺失：`126.75 亿元` → `126.75` 是丢了量纲，不能当"数字还在"放过。
 */
export function missingNumericFacts(source: string, output: string): string[] {
  const want = quantityFacts(source);
  if (want.length === 0) return [];
  const have = new Set(quantityFacts(output).map((f) => `${f.value}|${f.unit}`));
  const out = new Set<string>();
  for (const f of want) {
    if (have.has(`${f.value}|${f.unit}`)) continue;
    // 百分数与非百分数互认（12.7% ↔ 12.7）
    const alt = `${f.value}|${f.unit === "%" ? "" : "%"}`;
    if (f.unit === "%" || f.unit === "") {
      if (have.has(alt)) continue;
    }
    out.add(f.unit ? `${f.value}${f.unit}` : f.value);
  }
  return [...out];
}

/** 原文有、产出里**量纲被换掉**的那些量（数值还在，量纲变了） */
export function changedUnits(source: string, output: string): string[] {
  const outFacts = quantityFacts(output);
  const byValue = new Map<string, Set<string>>();
  for (const f of outFacts) {
    if (!byValue.has(f.value)) byValue.set(f.value, new Set());
    byValue.get(f.value)!.add(f.unit);
  }
  const bad: string[] = [];
  for (const f of quantityFacts(source)) {
    if (!f.unit) continue; // 原文没有量纲，无从比较
    const units = byValue.get(f.value);
    if (!units || units.size === 0) continue; // 数值整个没了 → 交给缺失检查
    if (!units.has(f.unit)) {
      const shown = [...units].map((u) => u || "（无量纲）").join("/");
      bad.push(`${f.value}${f.unit} → ${shown}`);
    }
  }
  return [...new Set(bad)];
}

/**
 * 面向用户的提示文案（两类失真都没有时返回 null）。
 * 文案会出现在 CLI 输出与界面 note 里，用户得知道"这不是评分问题，是稿子里动了原文的数据"。
 */
export function numericFidelityWarning(source: string, output: string): string | null {
  const parts: string[] = [];
  const missing = missingNumericFacts(source, output);
  if (missing.length) {
    const shown = missing.slice(0, 6).join("、");
    const more = missing.length > 6 ? ` 等 ${missing.length} 个` : "";
    parts.push(`产出缺少原文中的数字：${shown}${more}`);
  }
  const units = changedUnits(source, output);
  if (units.length) {
    const shown = units.slice(0, 4).join("；");
    const more = units.length > 4 ? ` 等 ${units.length} 处` : "";
    parts.push(`产出改了原文的数字单位：${shown}${more}`);
  }
  if (parts.length === 0) return null;
  return `${parts.join("；")}（内容失真，请核对；严格保真模式会因此回退原稿）`;
}
