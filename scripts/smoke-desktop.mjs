/**
 * smoke-desktop.mjs —— 桌面包启动冒烟（只验"能起来并活着"，不跑推理）
 *
 * 为什么需要它：`electron-app/verify-pruned.cjs` 只验三件事——模块可加载、随包文档/版本一致、
 * 产物来自当前源码指纹。它**不跑端到端**：主进程有没有崩、窗口有没有起来，它一句话都不说。
 * 而"双击没反应"恰恰是用户最容易遇到的失败形态。
 *
 * ⚠️ 本脚本存在的另一半原因是个坑（2026-10-23 实测）：
 *   如果父进程本身是 Electron 应用（例如某些 IDE / Agent 宿主），环境里往往带着
 *   `ELECTRON_RUN_AS_NODE=1`；子进程继承它之后，`QuAiWei.exe` 会**退化成普通 Node**：
 *   `QuAiWei.exe --version` 打印的是 Node 版本（如 v24.22.0）而不是 Electron 的 43.x，
 *   不带参数启动则进 REPL 卡死。看起来像"桌面版坏了"，实际是环境变量。
 *   → 本脚本启动前会把它从子进程环境里摘掉，并当场自证（先跑一次 `--version` 看输出形态）。
 *
 * 用法：node scripts/smoke-desktop.mjs [--exe <路径>] [--wait <秒>]
 * 退出码：0 起来并存活；1 启动即退；2 找不到产物/用法错
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const EXE = path.resolve(
  ROOT,
  argOf("--exe", path.join("electron-dist", "QuAiWei-win32-x64", "QuAiWei.exe")),
);
const WAIT_SEC = Number(argOf("--wait", "10"));

if (!fs.existsSync(EXE)) {
  console.error(`❌ 找不到 ${path.relative(ROOT, EXE)}`);
  console.error("   先跑 npm run build && cd electron-app && npm run repack");
  process.exit(2);
}

/** 子进程环境：摘掉会让 Electron 退化成 Node 的那几个变量 */
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

/** 自证：干净环境下 `--version` 应该打 Electron 版本（v43.x），而不是 Node 版本 */
function selfCheck() {
  const r = spawnSync(EXE, ["--version"], { env: cleanEnv(), encoding: "utf-8", timeout: 20_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  const m = /v(\d+)\.(\d+)\.(\d+)/.exec(out);
  if (!m) {
    console.warn(`   ⚠️ --version 没有输出可识别的版本号（exit=${r.status}），继续按启动存活判据走`);
    return;
  }
  const major = Number(m[1]);
  const kind = major >= 20 && major <= 30 ? "Node（大概率是 ELECTRON_RUN_AS_NODE 没摘干净）" : "Electron";
  console.log(`   自证：--version → ${out}（按主版本判断：${kind}）`);
}

console.log(`== 桌面冒烟：${path.basename(EXE)} ==`);
console.log(`   路径 ${EXE}`);
selfCheck();

const child = spawn(EXE, [], {
  env: cleanEnv(),
  cwd: path.dirname(EXE),
  detached: true,
  stdio: "ignore",
});
let exited = false;
child.on("exit", (code) => {
  exited = true;
  console.log(`   ⚠️ 进程提前退出，code=${code}`);
});
child.unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = () => {
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
};

const deadline = Date.now() + WAIT_SEC * 1000;
let ok = false;
while (Date.now() < deadline) {
  await sleep(500);
  if (exited || !alive()) break;
  if (Date.now() > deadline - WAIT_SEC * 500) ok = true; // 后半程仍存活 ⇒ 判过
}

// 收尾：只杀自己起的这棵树，别碰用户手动开的实例
try {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    process.kill(-child.pid, "SIGKILL");
  }
} catch {
  /* 已经退了就算了 */
}

if (ok) {
  console.log(`✅ 启动后存活 ≥${WAIT_SEC / 2}s，主进程没有立即崩（窗口是否可见请肉眼确认一次）`);
  process.exit(0);
}
console.error("❌ 启动即退：可能是缺 VC++ 运行库 / 被安全软件拦 / 产物不完整");
console.error("   排查顺序：事件查看器 → 应用程序日志（找 QuAiWei.exe 的 Application Error）→ 重跑 repack");
process.exit(1);
