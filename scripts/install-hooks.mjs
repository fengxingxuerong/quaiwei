/**
 * install-hooks.mjs —— 把 `.githooks/` 接成 git 的钩子目录（幂等，缺失即跳过）
 *
 * 为什么需要：`.githooks/pre-commit` 里有四道关键防线——密钥形态拦截、凭证账本
 * append-only、tsc、eslint + prettier——但 git 默认只跑 `.git/hooks/`。
 * 不设 `core.hooksPath` 的话，这四道一条都不会跑，而 README 与 CONTRIBUTING 写的是
 * "提交时已拦截"。2026-10-22 实测：某次克隆里 `core.hooksPath` 就是空的，
 * 钩子文件躺在仓库里但从未执行过。
 *
 * 触发方式：`npm install` / `npm ci` 的 prepare 钩子（本脚本），或手动 `npm run setup:hooks`。
 * 非 git 目录（解压出来的源码包、npm 包消费者）静默跳过 —— 那不是错误。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 跑 git，读不出值/命令失败时返回 null（调用方决定是跳过还是报错） */
function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return null;
  }
}

if (git(["rev-parse", "--git-dir"]) === null) {
  console.log("[hooks] 非 git 目录，跳过 core.hooksPath 设置");
  process.exit(0);
}

if (!existsSync(path.join(ROOT, ".githooks", "pre-commit"))) {
  console.log("[hooks] 没有 .githooks/pre-commit，跳过");
  process.exit(0);
}

const current = git(["config", "--get", "core.hooksPath"]) ?? "";
if (current === ".githooks") {
  console.log("[hooks] core.hooksPath 已是 .githooks，无需改动");
} else if (git(["config", "core.hooksPath", ".githooks"]) === null) {
  // 钩子接不上不该挡住装依赖（例如受限环境里 .git/config 不可写）
  console.warn("[hooks] 设置 core.hooksPath 失败（不影响使用，可手动执行 npm run setup:hooks）");
} else {
  console.log(`[hooks] 已设置 core.hooksPath=.githooks（原值：${current || "空"}）`);
}

console.log("[hooks] 提交时会跑：密钥形态拦截 → 账本 append-only → tsc → eslint → prettier");
