/**
 * scripts/lib/wikitext.ts —— MediaWiki wikitext → 纯散文（供交叉语料抓取复用）
 *
 * 逻辑与 artifacts/human-corpus/fetch-wiki.ts 的 cleanWikitext/toProse 同源
 * （那份是 2026-10-14 抓 21 篇长文时写的，已被 P1-1 基准台当作 no-touch 面板）。
 * 抽到这里是为了让「短真人稿」抓取走同一套清洗口径——否则两边文本口径不同，
 * formalPer1k 的对比就不可比。
 */

/** 去模板/表格/引用/注释，把 [[链接|文本]] 还原成文本 */
export function cleanWikitext(s: string): string {
  let t = s;
  t = t.replace(/<!--[\s\S]*?-->/g, "");
  t = t.replace(/<ref[^>]*\/>/gi, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
  for (let i = 0; i < 8 && t.includes("{{"); i++) {
    let depth = 0;
    let out = "";
    for (const ch of t) {
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
      if (depth === 0) out += ch;
    }
    t = out;
  }
  t = t.replace(/\{\|[\s\S]*?\|\}/g, "");
  t = t.replace(/\[\[(?:文件|File|檔案|图像):[^\]]*\]\]/gi, "");
  t = t.replace(/\[\[分类:[^\]]*\]\]/g, "");
  t = t.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1").replace(/\[\[([^\]]*)\]\]/g, "$1");
  t = t
    .replace(/\[(?:https?:|www\.)[^\s\]]*\s+([^\]]*)\]/gi, "$1")
    .replace(/\[(?:https?:|www\.)[^\s\]]*\]/gi, "");
  t = t.replace(/'''?/g, "");
  t = t.replace(/^\s*[#*;:]+\s*/gm, "");
  t = t.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  t = t.replace(/[{}]/g, "");
  t = t.replace(/^\s*=+.*=+\s*$/gm, "");
  return t;
}

/**
 * 段落清洗 + 质量过滤。
 * `minPara` 默认 60（长文口径）；抓短稿时传 30，否则短文整段被滤空。
 *
 * 括号配对检查是 2026-11-09 补的：剥模板（{{...}}）后常留下落单的 `（`
 * ——比如「宁德时代新能源科技股份有限公司（，简称CATL）」原本是
 * `{{lang-en|CATL}}` 被剥离后留了个空括号加逗号。这类残句会让密度读数失真，
 * 且肉眼很难在 400 字里发现。整段剔除比就地修补安全（修补要猜原文）。
 */
export function toProse(clean: string, minPara = 60): string {
  const paras = clean
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= minPara && p.length <= 1200)
    .filter((p) => (p.match(/[<>=|{}[\]]/g) || []).length / p.length < 0.03)
    .filter((p) => (p.match(/（/g) || []).length === (p.match(/）/g) || []).length)
    .filter((p) => (p.match(/\(/g) || []).length === (p.match(/\)/g) || []).length)
    .filter((p) => /^[\u4e00-\u9fa5（(“"]/.test(p));
  return paras.join("\n\n");
}
