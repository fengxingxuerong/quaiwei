/**
 * make-zip.mjs —— 打桌面包 zip + sha256（发版第 6 步）
 *
 * 为什么要有这个文件：此前的发版流程第 6 步写的是 `node artifacts/_make-zip.cjs`，
 * 而 `artifacts/` 整个目录在 .gitignore 里（只放行几个 *.ts）——换台机器克隆下来，
 * 按 CONTRIBUTING 走流程必然在最后一步找不到文件。产物命名与 CI
 * （.github/workflows/windows-build.yml）逐字一致，两条路径打出来的包同名同格式。
 *
 * 产物：
 *   electron-dist/QuAiWei-win32-x64-v<version>.zip
 *   electron-dist/QuAiWei-win32-x64-v<version>.zip.sha256   （`<hash>  <文件名>`，与 sha256sum 同格式）
 *
 * 依赖 7z（CI 的 windows runner 自带；本机装 7-Zip 后通常也在 PATH 里）。
 * 用法：node scripts/make-zip.mjs [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
const PAYLOAD = path.join(ROOT, "electron-dist", "QuAiWei-win32-x64");
const NAME = `QuAiWei-win32-x64-v${version}.zip`;
const ZIP = path.join(ROOT, "electron-dist", NAME);
const SHA_FILE = `${ZIP}.sha256`;

const die = (msg) => {
  console.error(`❌ ${msg}`);
  process.exit(1);
};

if (!fs.existsSync(PAYLOAD)) {
  die(`找不到产物目录：${path.relative(ROOT, PAYLOAD)}\n   先跑 npm run build && cd electron-app && npm run repack`);
}

// 公开包前置检查：带 Key 的包绝不能发出去（CI 里也有同样一条硬拦）
const KEY_FILE = path.join(PAYLOAD, "resources", "app", "preset-keys.txt");
if (fs.existsSync(KEY_FILE)) {
  die(
    `产物里有 ${path.relative(ROOT, KEY_FILE)} —— 这是**本地自用形态**，不能公开。\n` +
      "   先删掉 electron-app/preset-keys.txt，重跑 npm run build && cd electron-app && npm run repack，再打 zip。",
  );
}

/**
 * v0.9.73：**全树**再扫一遍 Key 与 repack 残留。
 *
 * 2026-10-24 实测踩到：repack 有一次在改名后清理失败，留下了
 * `resources/app.stale-<ts>`（整份旧 app + 里面那份 preset-keys.txt），
 * 上面的定点检查只认 `resources/app/preset-keys.txt`，于是**带 Key 的包差点发出去**，
 * 体积还从 203 MiB 涨到 267 MiB。这类残留只能靠遍历整棵产物树来兜。
 */
function walk(dir, hits) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name.includes(".stale-")) hits.push(p); // repack 的旧目录残留
      else walk(p, hits);
    } else if (ent.name === "preset-keys.txt" || /^\.stale-/.test(ent.name)) {
      hits.push(p);
    }
  }
  return hits;
}
const leftovers = walk(PAYLOAD, []).filter((p) => {
  // 正常形态下唯一的合法位置已在上面判过；这里只看"别处"
  return path.resolve(p) !== path.resolve(KEY_FILE);
});
if (leftovers.length) {
  die(
    `产物里有 ${leftovers.length} 个不该出现的残留（Key 文件或 .stale- 旧目录）：\n` +
      leftovers.map((p) => `   ${path.relative(ROOT, p)}`).join("\n") +
      "\n   这些会被原样打进交付包。先清掉它们（或重跑 repack 让脚本自己清理），再重新打包。",
  );
}

// 版本一致性：产物里的 package.json 必须与仓库根同版本（否则打出一个谎报版本的包）
const payloadPkg = path.join(PAYLOAD, "resources", "app", "package.json");
if (fs.existsSync(payloadPkg)) {
  const pv = JSON.parse(fs.readFileSync(payloadPkg, "utf-8")).version;
  if (pv !== version) die(`产物版本 ${pv} ≠ 仓库 ${version}，先重跑 repack`);
}

// 小白包随包带教程：把《使用教程.md》放进包根目录（rebuild-app 整目录重建会清掉它，
// 所以在打包这一步放，而不是指望 repack 保留）。文件不存在就静默跳过（老树也照常打包）。
const TUTORIAL = path.join(ROOT, "使用教程.md");
if (fs.existsSync(TUTORIAL)) {
  fs.copyFileSync(TUTORIAL, path.join(PAYLOAD, "使用教程.md"));
  console.log("📄 已随包放入：使用教程.md");
}

if (DRY) {
  console.log(`[dry-run] 将打包 ${path.relative(ROOT, PAYLOAD)} → electron-dist/${NAME}`);
  process.exit(0);
}

fs.rmSync(ZIP, { force: true });
fs.rmSync(SHA_FILE, { force: true });

try {
  execFileSync("7z", ["a", "-tzip", "-mx=6", "-y", ZIP, path.join(PAYLOAD, "*")], {
    cwd: ROOT,
    stdio: "inherit",
  });
} catch (e) {
  die(`7z 调用失败（${e.code ?? e.message}）。装 7-Zip 并确保 7z 在 PATH 里，或用 CI 的 Windows build 工作流。`);
}

const buf = fs.readFileSync(ZIP);
const hash = createHash("sha256").update(buf).digest("hex");
fs.writeFileSync(SHA_FILE, `${hash}  ${NAME}\n`, "ascii");

const mib = buf.length / 1048576;
console.log(`\n✅ ${NAME}（${mib.toFixed(1)} MiB）`);
console.log(`   sha256 ${hash}`);
console.log(`   校验文件 electron-dist/${NAME}.sha256`);
