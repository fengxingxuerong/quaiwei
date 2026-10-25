/**
 * 数字保真守卫（v0.9.76）
 *
 * 为什么要有：LLM 改写最常见的**内容失真**不是"写错数字"，而是**整句连数字一起删掉**。
 * 2026-10-24 的三体裁 × 五模型实测就抓到一次（deepseek-v4-flash · 财经快讯）：
 *
 *   原文：「报告期末，公司总资产达到 126.75 亿元，较上年末上升 6.3%，资产负债率维持在 41.2%……」
 *   产出：整句消失 —— 126.75 与 6.3% 两个数字直接没了，其余数字都在。
 *
 * 这类丢失在"财报/公文/招标"场景里是硬伤（读者据此开会），而单轮 LLM 路径**没有**
 * 深度模式的收稿终审与编造复核兜底（`--strict` 只在深度闭环里生效）。
 * 所以这里加一道**确定性**检查：原文出现的数字，产出里必须都还在。
 *
 * 设计边界（都是有意的）：
 *  - 只查**数字与百分数**，不查人名/机构名（中文实体的"同义改写"边界太模糊，误报率高）；
 *  - 归一化全角/半角数字与百分号、容忍千分位与省略 `%`（"12.7%" → "12.7" 视为同一事实）；
 *  - **只报不拦**（默认）：守卫返回值交给调用方决定是警告还是回退，避免把"改写成
 *    「一成二」这类合理转述"误判成丢事实；
 *  - 纯函数、零依赖、确定性——不消耗任何 API 调用。
 */

/** 从文本里抠出数字事实（归一化后排序去重） */
export function numericFacts(text: string): string[] {
  const norm = text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角数字
    .replace(/[．。]/g, (c) => (c === "．" ? "." : c)) // 全角小数点；句号不动（它不是小数点）
    .replace(/[％]/g, "%")
    .replace(/[，、]/g, ","); // 千分位里的中文逗号
  const out = new Set<string>();
  for (const m of norm.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?%?/g)) {
    out.add(m[0].replace(/,/g, ""));
  }
  return [...out].sort();
}

/**
 * 产出里**缺失**的数字事实。
 *
 * 判定口径：把两侧都归一成"数字集合"，产出里没有的原文数字即缺失。
 * 注意 `12.7%` 与 `12.7` 视为同一事实（有的模型会把百分号改写成"百分之 12.7"）——
 * 反过来 `12.7` 在原文、产出写成 `12.7%` 也算命中，宁可漏报不误报。
 */
export function missingNumericFacts(source: string, output: string): string[] {
  const want = numericFacts(source);
  if (want.length === 0) return [];
  const have = new Set(numericFacts(output).map((n) => n.replace(/%$/, "")));
  return want.filter((n) => !have.has(n.replace(/%$/, "")));
}

/**
 * 面向用户的提示文案（缺失时返回 null）。
 * 之所以要文案而不是裸数组：这条提示会出现在 CLI 输出与界面 note 里，
 * 用户得知道"这不是评分问题，是稿子里少了原文的数据"。
 */
export function numericFidelityWarning(source: string, output: string): string | null {
  const missing = missingNumericFacts(source, output);
  if (missing.length === 0) return null;
  const shown = missing.slice(0, 6).join("、");
  const more = missing.length > 6 ? ` 等 ${missing.length} 个` : "";
  return `产出缺少原文中的数字：${shown}${more}（内容失真，请核对；严格保真模式会因此回退原稿）`;
}
