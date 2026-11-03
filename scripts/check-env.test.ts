/**
 * check-env 单测：环境预检的三类形态（健康 / 空壳包 / 版本错位）必须都能被抓到。
 * 2026-11-03 事故的回归锚：@esbuild/win32-x64 目录在场但 esbuild.exe 缺失时，
 * 31 个用例红了 4 天没人发现——这里固化「空壳包必须红、红必须带修法」。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { checkEnv, type EnvCheckOptions } from "./check-env";

/**
 * 仓库根必须从模块位置反推，不能用 process.cwd()：
 * coverage-gate 用 `cwd: os.tmpdir()` + `--root` 起 vitest（这是本机跑通全量的前提），
 * 此时 cwd 是临时目录，拿它当根会找不到 node_modules/tsx|vitest → 门禁永久假红。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qw-check-env-"));
  // 造假根：package.json（engines）+ esbuild JS 包 + 平台包空壳 + tsx/vitest 占位
  fs.writeFileSync(
    path.join(tmpRoot, "package.json"),
    JSON.stringify({ engines: { node: ">=18" } }),
  );
  const nm = path.join(tmpRoot, "node_modules");
  fs.mkdirSync(path.join(nm, "esbuild"), { recursive: true });
  fs.writeFileSync(
    path.join(nm, "esbuild", "package.json"),
    JSON.stringify({ version: "0.28.2" }),
  );
  const platDir = path.join(nm, "@esbuild", `${process.platform}-${process.arch}`);
  fs.mkdirSync(platDir, { recursive: true });
  for (const dep of ["tsx", "vitest"]) {
    fs.mkdirSync(path.join(nm, dep), { recursive: true });
    fs.writeFileSync(path.join(nm, dep, "package.json"), "{}");
  }
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 二进制在场的假形态：>1MB 的占位文件 + 可注入的假执行器 */
function plantBinary(root: string): string {
  const bin = path.join(
    root,
    "node_modules",
    "@esbuild",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "esbuild.exe" : path.join("bin", "esbuild"),
  );
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, Buffer.alloc(2 * 1024 * 1024));
  return bin;
}

const okRunner: EnvCheckOptions["runBinary"] = () => ["0.28.2", null];

describe("check-env：环境预检", () => {
  it("真仓库（本机/CI）环境健康——这道测试本身就是门禁的自证", () => {
    const rows = checkEnv(ROOT);
    const bad = rows.filter((r) => !r.ok);
    expect(bad).toEqual([]);
  });

  it("空壳平台包（2026-11-03 事故形态）：二进制缺失必须红，且修法可照着敲", () => {
    // 平台包目录存在（今天事故里 README/package.json 都在）但没有二进制
    fs.writeFileSync(path.join(tmpRoot, "node_modules", "@esbuild", `${process.platform}-${process.arch}`, "README.md"), "shell");
    const rows = checkEnv(tmpRoot, { nodeVersion: "24.22.1", runBinary: okRunner });
    const esbuildRow = rows.find((r) => r.loc.includes("平台二进制（@esbuild/"));
    expect(esbuildRow?.ok).toBe(false);
    expect(esbuildRow?.detail).toContain("空壳/残缺包");
    expect(esbuildRow?.fix).toContain("npm install @esbuild/");
    expect(esbuildRow?.fix).toContain("npm pack"); // 缓存/杀毒场景的手动补法
  });

  it("TS 原生编译器（2026-11-03 事故二形态）：tsc.exe 缺失必须红", () => {
    // 宿主包在场 + 平台包空壳（事故二里 tsc.exe 被删，lib/*.d.ts 还在）
    const nm = path.join(tmpRoot, "node_modules");
    fs.mkdirSync(path.join(nm, "@typescript", "native"), { recursive: true });
    fs.writeFileSync(path.join(nm, "@typescript", "native", "package.json"), JSON.stringify({ version: "7.0.2" }));
    const rows = checkEnv(tmpRoot, { nodeVersion: "24.22.1", runBinary: okRunner });
    const tscRow = rows.find((r) => r.loc.includes("typescript-win32-x64") || r.loc.includes("typescript-"));
    expect(tscRow?.ok).toBe(false);
    expect(tscRow?.fix).toContain("npm pack @typescript/typescript-");
  });

  it("TS 平台二进制在场但 lib.dom.d.ts 缺失：完整性检查必须红（假 DOM 类型错的前兆）", () => {
    const nm = path.join(tmpRoot, "node_modules");
    fs.mkdirSync(path.join(nm, "@typescript", "native"), { recursive: true });
    fs.writeFileSync(path.join(nm, "@typescript", "native", "package.json"), JSON.stringify({ version: "7.0.2" }));
    const tsPkg = path.join(nm, "@typescript", `typescript-${process.platform}-${process.arch}`);
    fs.mkdirSync(path.join(tsPkg, "lib"), { recursive: true });
    fs.writeFileSync(path.join(tsPkg, "lib", process.platform === "win32" ? "tsc.exe" : "tsc"), Buffer.alloc(2 * 1024 * 1024));
    // lib.dom.d.ts 不写 → 完整性行红；执行行仍绿（runBinary 返回同版本）
    const rows = checkEnv(tmpRoot, { nodeVersion: "24.22.1", runBinary: () => ["Version 7.0.2", null] });
    const integrity = rows.find((r) => r.loc.includes("完整性文件"));
    expect(integrity?.ok).toBe(false);
    expect(integrity?.detail).toContain("lib.dom.d.ts");
    const exec = rows.find((r) => r.loc.includes("@typescript/native 二进制可执行"));
    expect(exec?.ok).toBe(true); // 版本一致（前缀 "Version " 已剥离）
  });

  it("二进制在场但版本与 JS 包错位：必须红", () => {
    plantBinary(tmpRoot);
    const rows = checkEnv(tmpRoot, {
      nodeVersion: "24.22.1",
      runBinary: () => ["0.27.0", null],
    });
    const execRow = rows.find((r) => r.loc === "esbuild 二进制可执行");
    expect(execRow?.ok).toBe(false);
    expect(execRow?.detail).toContain("不一致");
  });

  it("二进制在场且版本一致：esbuild 三连全绿", () => {
    plantBinary(tmpRoot);
    const rows = checkEnv(tmpRoot, { nodeVersion: "24.22.1", runBinary: okRunner });
    const esbuildRows = rows.filter((r) => r.loc.includes("esbuild"));
    expect(esbuildRows.every((r) => r.ok)).toBe(true);
  });

  it("node 低于 engines 下限：必须红（>=18 引擎 vs 16.20.0）", () => {
    const rows = checkEnv(tmpRoot, { nodeVersion: "16.20.0", runBinary: okRunner });
    const nodeRow = rows.find((r) => r.loc.includes("node 版本"));
    expect(nodeRow?.ok).toBe(false);
    expect(nodeRow?.fix).toContain(">=18");
  });

  it("tsx/vitest 缺失：必须红并指向 npm ci", () => {
    fs.rmSync(path.join(tmpRoot, "node_modules", "tsx"), { recursive: true, force: true });
    const rows = checkEnv(tmpRoot, { nodeVersion: "24.22.1", runBinary: okRunner });
    const tsxRow = rows.find((r) => r.loc.includes("tsx"));
    expect(tsxRow?.ok).toBe(false);
    expect(tsxRow?.fix).toContain("npm ci");
  });

  it("engines 字段缺失：不误报（宁漏报不误报）", () => {
    fs.writeFileSync(path.join(tmpRoot, "package.json"), JSON.stringify({ name: "x" }));
    const rows = checkEnv(tmpRoot, { nodeVersion: "16.20.0", runBinary: okRunner });
    const nodeRow = rows.find((r) => r.loc.includes("node 版本"));
    expect(nodeRow?.ok).toBe(true);
  });
});
