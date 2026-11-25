/**
 * _split-cap-ab-prepare.ts —— 为「碎句约束」双席 A/B 组装两臂（不动产品代码）
 *
 * 两臂：
 *   arms-engine = humanize() 原样输出（当前默认行为）
 *   arms-capped = 同上，但把「原文该位置本来是逗号」的多余句号精确还原（判据见 _split-cap-offline.ts）
 *
 * 语料两组，偏置方向相反，这是设计要点：
 *   H-* 人写长文（artifacts/human-corpus）：还原版更接近人写原文 ⇒ 偏袒 capped
 *   A-* AI 稿（scripts/realcase 高比值 + DetectRL 机器标注长样本）：还原版更接近机器原文 ⇒ 偏袒 engine
 *   ⇒ 只有两方向同时赢，才说明「限制切句」本身有效，而不是「更像原文」效应。
 *
 * 用法：npx tsx scripts/_split-cap-ab-prepare.ts [--write]
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { humanize } from "../../src/engine/humanize.ts";
import { splitSentences } from "../../src/engine/humanize-text.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const BASE = "D:/projects/_quaiwei-tmp/split-cap-ab-2026-11-26";
const WRITE = process.argv.includes("--write");
const RATIO = 1.2;

const norm = (s: string) => s.replace(/\s+/g, "");

/**
 * 逐行还原多余切点。**只在同一行内合并**，换行符一个都不动。
 *
 * ⚠️ 教训（2026-11-26 第一版报废）：先用 splitSentences(全文)→join("") 实现，
 *    splitSentences 在 [。！？；\n] 处切并 trim，join("") 会把段落空行吃掉 ⇒
 *    28/29 对受限臂被压成单段，评委只会判「单段那版更像 AI」，数据全废。
 *    且 norm 去空白后跨段落的两句也能通过「原文子串」检查，等于允许把两段焊成一段。
 *    ⇒ 现在按行切分、按行合并；无合并的行必须逐字节还原（mismatch 计数应为 0）。
 */
function capSplits(origNorm: string, out: string, targetRatio: number) {
  const lines = out.split("\n");
  const perLine = lines.map((ln) => splitSentences(ln).map((s) => s.trim()).filter(Boolean));
  const nIn = splitSentences(origNorm).length;
  const total0 = perLine.reduce((a, s) => a + s.length, 0);
  const limit = Math.max(1, Math.ceil(nIn * targetRatio));
  let mismatch = 0;
  const locked = new Set<number>();

  // 基线校验：不合并时逐行拼回必须与原行逐字节相同；做不到的行整行锁定（原样保留、不参与合并）
  for (let li = 0; li < lines.length; li++) {
    if (perLine[li].length === 0) continue;
    if (perLine[li].join("") !== lines[li]) {
      mismatch++;
      locked.add(li);
    }
  }

  let total = total0;
  let restored = 0;
  while (total > limit) {
    let bestLi = -1;
    let bestI = -1;
    let bestLen = Infinity;
    for (let li = 0; li < perLine.length; li++) {
      if (locked.has(li)) continue;
      const s = perLine[li];
      for (let i = 0; i < s.length - 1; i++) {
        const a = s[i];
        // 只还原「原文本来就是逗号」的边界：句号→逗号，且合并后串是原文子串
        if (!a.endsWith("。")) continue;
        if (!origNorm.includes(`${norm(a).slice(0, -1)}，${norm(s[i + 1])}`)) continue;
        if (a.length < bestLen) {
          bestLen = a.length;
          bestLi = li;
          bestI = i;
        }
      }
    }
    if (bestLi < 0) break;
    const s = perLine[bestLi];
    s[bestI] = s[bestI].slice(0, -1) + "，" + s[bestI + 1];
    s.splice(bestI + 1, 1);
    total--;
    restored++;
  }

  const text = lines
    .map((ln, li) => (perLine[li].length > 0 && !locked.has(li) ? perLine[li].join("") : ln))
    .join("\n");
  return { text, nIn, nOut: total, ratio: nIn > 0 ? total / nIn : 0, restored, lockedLines: mismatch };
}

interface Item {
  id: string;
  group: "H" | "A";
  text: string;
}

const items: Item[] = [];

// —— 人写长文 ——
const CORPUS = path.join(ROOT, "artifacts/human-corpus");
for (const f of readdirSync(CORPUS).sort()) {
  if (!f.endsWith(".txt") || f.startsWith("_")) continue;
  const raw = readFileSync(path.join(CORPUS, f), "utf8");
  const i = raw.indexOf("\n\n");
  const text = (i >= 0 ? raw.slice(i + 2) : raw).trim();
  const L = norm(text).length;
  if (L < 400 || L > 12000) continue;
  items.push({ id: `H-${f.replace(/\.txt$/, "").slice(0, 22)}`, group: "H", text });
}

// —— AI 稿：realcase ——
const CASES = (
  JSON.parse(readFileSync(path.join(ROOT, "scripts/realcase/cases.json"), "utf8")) as {
    cases: { id: string; text: string }[];
  }
).cases;
for (const c of CASES) items.push({ id: `A-${c.id}`, group: "A", text: c.text });

// —— AI 稿：DetectRL 机器标注长样本（LCG seed 20261126 洗牌后取最长 12 篇候选）——
const DR = JSON.parse(readFileSync(path.join(ROOT, "artifacts/open-datasets/detectrl-zh-dev.json"), "utf8")) as {
  text: string;
  label: number;
}[];
const machine = DR.filter((x) => Number(x.label) === 1 && norm(x.text).length >= 700);
let seed = 20261126;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
for (let i = machine.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [machine[i], machine[j]] = [machine[j], machine[i]];
}
machine
  .slice(0, 12)
  .forEach((x, k) => items.push({ id: `A-DR${String(k + 1).padStart(2, "0")}`, group: "A", text: x.text.trim() }));

// —— 生成两臂 ——
const rows: any[] = [];
for (const it of items) {
  const engine = humanize(it.text, { intensity: 0.9, seed: 20261015 });
  const capped = capSplits(norm(it.text), engine, RATIO);
  const nIn = splitSentences(norm(it.text)).length;
  const rBefore = nIn > 0 ? splitSentences(engine).length / nIn : 0;
  rows.push({
    id: it.id,
    group: it.group,
    chars: norm(it.text).length,
    nIn,
    rBefore,
    rAfter: capped.ratio,
    restored: capped.restored,
    eligible: rBefore >= 1.3 && capped.restored >= 3,
  });
  if (WRITE && rows[rows.length - 1].eligible) {
    for (const [arm, t] of [
      ["corpus", it.text],
      ["arms-engine", engine],
      ["arms-capped", capped.text],
    ] as const) {
      mkdirSync(path.join(BASE, arm), { recursive: true });
      writeFileSync(path.join(BASE, arm, `${it.id}.${arm === "corpus" ? "" : `humanized.`}txt`), t, "utf8");
    }
  }
}

const f2 = (n: number) => n.toFixed(2);
console.log(["id", "grp", "chars", "nIn", "rBefore", "rAfter", "restored", "用"].join("\t"));
for (const r of rows)
  console.log([r.id.padEnd(26), r.group, r.chars, r.nIn, f2(r.rBefore), f2(r.rAfter), r.restored, r.eligible ? "✓" : ""].join("\t"));

for (const g of ["H", "A"] as const) {
  const gs = rows.filter((r) => r.group === g);
  const el = gs.filter((r) => r.eligible);
  console.log(
    `\n${g} 组：${gs.length} 篇，合格 ${el.length} 篇 | rBefore 中位 ${f2(gs.map((r) => r.rBefore).sort((a, b) => a - b)[Math.floor(gs.length / 2)])}` +
      ` → rAfter 中位 ${f2(el.map((r) => r.rAfter).sort((a, b) => a - b)[Math.floor(el.length / 2)] ?? 0)}`,
  );
}
if (WRITE) console.log(`\n已写入 ${BASE}`);
