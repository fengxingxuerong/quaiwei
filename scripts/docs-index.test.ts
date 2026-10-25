/**
 * docs/ 索引的守卫（v0.9.75）
 *
 * 为什么要有：docs/ 下十几份文档是**过程材料**（复盘/报告/证据/方案），带日期的居多。
 * 没有索引时，新读者分辨不出「哪份是当前口径、哪份是两版之前的切片」，很容易照着
 * 过期结论改代码。索引本身也会漂移（加了文档忘了登记），所以用测试锁住两个方向：
 *
 *   ① docs/ 里每个文档都必须在索引里出现（漏登记 → 红）；
 *   ② 索引里出现的每个链接都必须指向真实存在的文件（写错名 → 红）。
 *
 * 例外：索引自身（README.md）与工具产物（*.artifact.json）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");
const INDEX = path.join(DOCS, "README.md");

/** docs/ 下需要登记的文档（排除索引自身与工具产物） */
function docsFiles(): string[] {
  return fs
    .readdirSync(DOCS)
    .filter((f) => fs.statSync(path.join(DOCS, f)).isFile())
    .filter((f) => f !== "README.md")
    .filter((f) => !f.endsWith(".artifact.json"))
    .sort();
}

/** 索引里的相对链接（形如 `[标题](文件名)`，只取 docs/ 内的裸文件名） */
function indexedNames(): string[] {
  const text = fs.readFileSync(INDEX, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = m[1].trim();
    if (/^(https?:|#|mailto:)/.test(target)) continue;
    out.push(decodeURIComponent(target));
  }
  return out;
}

describe("docs/ 索引", () => {
  it("docs/ 里的每份文档都在索引里登记了", () => {
    const missing = docsFiles().filter((f) => !indexedNames().includes(f));
    expect(missing, `docs/README.md 没登记这些文件：${missing.join("、")}`).toEqual([]);
  });

  it("索引里的每个链接都指向真实存在的文件", () => {
    const broken = indexedNames().filter((f) => !fs.existsSync(path.join(DOCS, f)));
    expect(broken, `docs/README.md 里的死链：${broken.join("、")}`).toEqual([]);
  });

  it("索引给了「类型」层面：每份登记项都带一个已知分类", () => {
    // 分类不是排版洁癖：读者靠它判断「能不能照着做」。四个已知集合之外的值一律红。
    const known = /当前口径|证据|计划|复盘|缺陷报告|复核|实测报告|体检|对标|方案/;
    const text = fs.readFileSync(INDEX, "utf8");
    const rows = text.split("\n").filter((l) => /^\|\s*\[.+\]\(.+\)/.test(l));
    expect(rows.length, "索引里应有登记行").toBeGreaterThan(10);
    for (const row of rows) {
      expect(known.test(row), `登记行缺少已知分类：${row.slice(0, 80)}`).toBe(true);
    }
  });
});
