/**
 * src/pkg-version.ts —— 版本号读取的唯一入口（CLI `--version` 与 MCP `serverInfo.version` 共用）。
 *
 * 为什么不硬编码：版本号有 9 个落点（package.json、electron-app/package.json、README、SKILL.md…），
 * 硬编码第 10 个只会多一处漂移源。`scripts/check-version-sync.ts` 已经在校验这些落点，
 * 这里直接从最近的 package.json 读，读不到就报 unknown（**不猜、不回落成 0.0.0**）。
 *
 * 路径候选的顺序无关紧要，两个都要试：
 *  · 源码树：scripts/humanize-cli.ts → `../package.json`；src/mcp/server.ts → `../../package.json`
 *  · 打包产物：dist-cli/*.mjs（esbuild 单文件）→ `../package.json` 就是仓库根/安装包根
 * esbuild 把本模块内联进产物后，`import.meta.url` 指向**产物文件**，所以两种形态都能命中。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 读 package.json 的 version；读不到返回 "unknown" */
export function readPackageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(here, rel), "utf8")).version;
      if (typeof v === "string" && v.trim()) return v.trim();
    } catch {
      // 换下一个候选路径：源码树下是 ../../，打包产物下是 ../
    }
  }
  return "unknown";
}
