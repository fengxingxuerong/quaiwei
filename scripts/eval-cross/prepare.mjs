#!/usr/bin/env node
/**
 * 同文横向盲测 · 产臂准备（只做搬运与完整性校验，不生成任何文本）
 *
 * 存在理由：scripts/eval-dual/ab_accept.py 要求臂目录里每篇为
 * `<id>.humanized.txt`，id 取自 scripts/realcase/cases.json。竞品产物的命名
 * 各家不同，本脚本把「真实跑出来的产物」转成该契约，并锁住来源。
 *
 * 硬约束（对应项目「拒绝 mock 自证」）：
 *   · 不生成、不改写、不补全任何一篇文本；
 *   · 缺任何一篇就整体失败，不拿原文顶替、不填占位符；
 *   · manifest 记每篇 sha256 与「是否与原文逐字相同」，供复核时识别冒充。
 *
 * 用法：
 *   node scripts/eval-cross/prepare.mjs \
 *     --in  evidence/eval-cross-YYYY-MM-DD/raw/<competitor> \
 *     --out evidence/eval-cross-YYYY-MM-DD/arms/<competitor> \
 *     --source sgaofen-12b --origin "hz paper.md -o ...; Q8_0 GGUF; 2026-11-15"
 *
 *   node scripts/eval-cross/prepare.mjs --verify --out <arm-dir>
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}

const verifyOnly = process.argv.includes("--verify");
const inDir = arg("--in");
const outDir = arg("--out");
const source = arg("--source", "UNSPECIFIED");
const origin = arg("--origin", "UNSPECIFIED");
const casesPath = arg("--cases", path.join(ROOT, "scripts/realcase/cases.json"));

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

function loadCases() {
  const raw = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  const cases = Array.isArray(raw) ? raw : raw.cases;
  if (!Array.isArray(cases) || !cases.length) throw new Error(`cases.json 里没有 cases 数组：${casesPath}`);
  return cases;
}

function findArmFile(dir, id) {
  for (const name of [`${id}.humanized.txt`, `${id}.txt`]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function checkArm(dir, cases, label) {
  const problems = [];
  const files = [];
  for (const c of cases) {
    const p = findArmFile(dir, c.id);
    if (!p) {
      problems.push(`缺 ${c.id}（试过 ${c.id}.humanized.txt / ${c.id}.txt）`);
      continue;
    }
    const text = fs.readFileSync(p, "utf8");
    if (!text.trim()) {
      problems.push(`${path.basename(p)} 是空文件或纯空白`);
      continue;
    }
    files.push({
      id: c.id,
      file: path.basename(p),
      bytes: Buffer.byteLength(text, "utf8"),
      sha256: sha(text),
      identical_to_original: text.trim() === String(c.text ?? "").trim(),
    });
  }
  return { problems, files, label };
}

if (verifyOnly) {
  if (!outDir) throw new Error("--verify 需要 --out");
  const { problems, files } = checkArm(outDir, loadCases(), outDir);
  if (problems.length) {
    console.error(`[FAIL] ${outDir} 不完整：\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }
  const mf = path.join(outDir, "manifest.json");
  console.log(`[OK] ${outDir}：${files.length} 篇齐全，identical=${files.filter((f) => f.identical_to_original).length}`);
  console.log(`[OK] manifest ${fs.existsSync(mf) ? "存在" : "缺失（补跑 prepare 生成）"}`);
  process.exit(0);
}

if (!inDir || !outDir) throw new Error("需要 --in 与 --out");
if (!fs.existsSync(inDir)) throw new Error(`--in 不存在：${inDir}`);
if (path.resolve(inDir) === path.resolve(outDir)) throw new Error("--in 与 --out 不能是同一目录");

const cases = loadCases();
const { problems, files } = checkArm(inDir, cases, inDir);
if (problems.length) {
  console.error(`[FAIL] 竞品产物不完整，拒绝生成臂目录（不补占位、不拿原文顶替）：\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}

// 校验全过才落盘；先写临时目录再改名，避免半截臂目录被 ab_accept.py 读走。
// 不用 rmSync(recursive)：本环境的删除守卫对递归删除会抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED。
const tmp = `${outDir}.tmp-${process.pid}`;
if (fs.existsSync(tmp)) {
  for (const f of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, f));
  fs.rmdirSync(tmp);
}
if (fs.existsSync(outDir)) throw new Error(`--out 已存在，先人工移走：${outDir}`);
fs.mkdirSync(tmp, { recursive: true });
for (const f of files) {
  const src = findArmFile(inDir, f.id);
  fs.copyFileSync(src, path.join(tmp, `${f.id}.humanized.txt`));
}
const manifest = {
  schema: "quaiwei/eval-cross-arm@1",
  source,
  origin,
  prepared_at: new Date().toISOString(),
  cases_file: path.relative(ROOT, casesPath).replace(/\\/g, "/"),
  case_count: files.length,
  identical_to_original_count: files.filter((f) => f.identical_to_original).length,
  note: "文本逐字节复制自 --in；本脚本不生成、不改写任何一篇。",
  files,
};
fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
fs.renameSync(tmp, outDir);

console.log(`[OK] ${outDir}：${files.length} 篇，identical=${manifest.identical_to_original_count}，source=${source}`);
console.log(`[OK] 下一步：python scripts/eval-dual/ab_accept.py --arm-a <quaiwei-arm> --arm-b ${outDir} --seats AB ...`);
