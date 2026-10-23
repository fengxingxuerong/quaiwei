/**
 * v0.9.66：CLI 外部检测器（`--detector-url`）端到端测试
 *
 * 为什么要它：这条通道的意义是「不绑定任何厂商」——用户填任意一个
 * POST {text} → JSON 的接口，就能拿到原文/产出的外部前后分。
 * 关键行为有三条，都必须锁住：
 *   1. 原文与产出**各送检一次**（不是只送产出）；
 *   2. 分数与降幅进 `--report` 的 detectorBefore / detectorAfter；
 *   3. 检测器挂了**不许中断出稿**（额度/网络问题不该让整批白跑）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = path.join(ROOT, "scripts", "humanize-cli.ts");

const SAMPLE =
  "值得注意的是，随着人工智能技术的不断发展，数字化办公已成为大势所趋。综上所述，这一变革极大地提升了工作效率与协同质量。";

let server: http.Server;
let port = 0;
const seen: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const text = (JSON.parse(body || "{}") as { text?: string }).text ?? "";
      seen.push(text);
      // 假检测器：字数越多分越高（去味后字数会变，天然产生前后差）
      const score = Math.max(0, Math.min(100, Math.round(text.length / 8)));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { prob: score } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qw-detector-"));
}

describe("CLI 外部检测器（--detector-url）", () => {
  it("原文与产出各送检一次，前后分与降幅写进 report", async () => {
    const dir = tmpDir();
    const input = path.join(dir, "a.txt");
    fs.writeFileSync(input, SAMPLE, "utf-8");
    const report = path.join(dir, "r.json");
    seen.length = 0;

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        TSX,
        CLI,
        input,
        "--out",
        dir,
        "--report",
        report,
        "--intensity",
        "0.9",
        "--seed",
        "7",
        "--detector-url",
        `http://127.0.0.1:${port}`,
        "--detector-path",
        "data.prob",
      ],
      { cwd: ROOT, timeout: 120_000 },
    );

    expect(seen.length, "原文与产出应各送检一次").toBe(2);
    expect(seen[0]).toBe(SAMPLE); // 第一次送的是原文
    expect(stdout).toContain("外部检测器");

    const rep = JSON.parse(fs.readFileSync(report, "utf-8")) as {
      reports: { detectorBefore?: number; detectorAfter?: number; detectorError?: string }[];
    };
    const row = rep.reports[0];
    expect(row.detectorError).toBeUndefined();
    expect(typeof row.detectorBefore).toBe("number");
    expect(typeof row.detectorAfter).toBe("number");
    // 假检测器按字数给分；去味后字数变化即产生差值 —— 只断言"取到了前后两个值"
    expect(row.detectorBefore).not.toBeNull();
  }, 120_000);

  it("检测器不可用时不中断出稿，只把原因记进 report", async () => {
    const dir = tmpDir();
    const input = path.join(dir, "b.txt");
    fs.writeFileSync(input, SAMPLE, "utf-8");
    const report = path.join(dir, "r.json");

    // 指向一个没人监听的端口：连接会被立即拒绝
    await execFileAsync(
      process.execPath,
      [
        TSX,
        CLI,
        input,
        "--out",
        dir,
        "--report",
        report,
        "--intensity",
        "0.6",
        "--seed",
        "7",
        "--detector-url",
        "http://127.0.0.1:1/",
      ],
      { cwd: ROOT, timeout: 120_000 },
    );

    // 产物照常落盘（出稿没有被检测器拖累）
    const outs = fs.readdirSync(dir).filter((f) => f.endsWith(".txt") && f !== "b.txt");
    expect(outs.length, "检测器失败时仍应产出结果文件").toBeGreaterThan(0);

    const rep = JSON.parse(fs.readFileSync(report, "utf-8")) as {
      reports: { detectorError?: string; detectorBefore?: number | null }[];
    };
    expect(typeof rep.reports[0].detectorError).toBe("string");
    expect(rep.reports[0].detectorError?.length).toBeGreaterThan(0);
    expect(rep.reports[0].detectorBefore ?? null).toBeNull();
  }, 120_000);

  it("--detector-scale 只认 0-100 / 0-1，其余用法错（退出码 2）", async () => {
    const dir = tmpDir();
    const input = path.join(dir, "c.txt");
    fs.writeFileSync(input, SAMPLE, "utf-8");
    await expect(
      execFileAsync(
        process.execPath,
        [TSX, CLI, input, "--out", dir, "--detector-url", "http://x/", "--detector-scale", "0-2"],
        { cwd: ROOT, timeout: 60_000, env: { ...process.env } },
      ),
    ).rejects.toMatchObject({ code: 2 });
  }, 60_000);
});
