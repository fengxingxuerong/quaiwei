/**
 * --report 的凭证脱敏（v0.9.92）
 *
 * 为什么要有这条：`--report` 产出的 JSON 常被当成对外附件——发同事、发客户、贴进 issue。
 * 修前它把 `args.apiKey` / `args.detectorKey` / `args.detectors[].key` 原样写进去，
 * 等于把网关凭证附在报告里一起送出去（2026-11-26 完整回归时实测触发：bailu key 明文落盘）。
 *
 * 断言的是**实际文件内容**，不是函数返回值：脱敏发生在落盘那一层，读回来才算数。
 * 同时守住反向条件——没配 key 时保持空串，不能看见 "***" 满天飞让人误以为配过。
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = path.join(ROOT, "scripts", "humanize-cli.ts");

const AI_TEXT =
  "本文首先阐述了人工智能技术的发展现状，其次分析了其在各行各业中的广泛应用。综上所述，人工智能技术具有广阔的发展前景，值得我们高度重视。";

const API_KEY = "sk-test-secret-should-never-land-0123456789";
const DETECTOR_KEY = "dsk-test-secret-should-never-land-9876543210";

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `quaiwei-redact-${tag}-`));
}

/** 跑 CLI（本地引擎路径，不开 --api，所以不会真的发网络请求）。 */
async function runCli(argv: string[]): Promise<{ code: number; stderr: string }> {
  try {
    const { stderr } = await execFileAsync(process.execPath, [TSX, CLI, ...argv], {
      cwd: ROOT,
      timeout: 90_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stderr };
  } catch (e) {
    const err = e as Error & { code?: number; stderr?: string };
    return { code: err.code ?? 1, stderr: err.stderr ?? "" };
  }
}

describe("humanize-cli --report 凭证脱敏", () => {
  it("--api-key / --detector-key 不进报告文件，只留 *** 占位", async () => {
    const dir = tmpDir("keys");
    const input = path.join(dir, "in.txt");
    const out = path.join(dir, "out");
    const report = path.join(dir, "report.json");
    fs.writeFileSync(input, AI_TEXT, "utf8");

    const r = await runCli([
      input,
      "--out",
      out,
      "--force-low-risk",
      "--api-key",
      API_KEY,
      "--detector-url",
      "https://example.invalid/score",
      "--detector-key",
      DETECTOR_KEY,
      "--report",
      report,
    ]);
    expect(r.code).toBe(0);

    const raw = fs.readFileSync(report, "utf8");
    // 反向条件：密钥本体不得出现在文件任何位置
    expect(raw).not.toContain(API_KEY);
    expect(raw).not.toContain(DETECTOR_KEY);

    const parsed = JSON.parse(raw) as {
      args: {
        apiKey: string;
        detectorKey: string;
        intensity: number;
        detectors: { key: string; url: string }[];
      };
    };
    expect(parsed.args.apiKey).toBe("***");
    expect(parsed.args.detectorKey).toBe("***");
    expect(parsed.args.detectors).toHaveLength(1);
    expect(parsed.args.detectors[0].key).toBe("***");
    // 非凭证字段照旧透传，脱敏不能顺手改坏别的
    expect(parsed.args.detectors[0].url).toBe("https://example.invalid/score");
    expect(parsed.args.intensity).toBe(0.6);
  }, 120_000);

  it("没配凭证时保持空串，不写 ***（避免误判为已配置）", async () => {
    const dir = tmpDir("nokey");
    const input = path.join(dir, "in.txt");
    const out = path.join(dir, "out");
    const report = path.join(dir, "report.json");
    fs.writeFileSync(input, AI_TEXT, "utf8");

    const r = await runCli([input, "--out", out, "--report", report]);
    expect(r.code).toBe(0);

    const raw = fs.readFileSync(report, "utf8");
    const parsed = JSON.parse(raw) as { args: { apiKey: string; detectorKey: string } };
    expect(parsed.args.apiKey).toBe("");
    expect(parsed.args.detectorKey).toBe("");
    expect(raw).not.toContain("***");
  }, 120_000);
});
