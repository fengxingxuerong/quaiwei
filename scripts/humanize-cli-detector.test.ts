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
      seen.push(`${req.url ?? "/"}::${text}`);
      // 假检测器：字数越多分越高（去味后字数会变，天然产生前后差）
      const raw = Math.max(0, Math.min(100, Math.round(text.length / 8)));
      res.writeHead(200, { "Content-Type": "application/json" });
      // v0.9.71：两个路径给不同形状/刻度，验证「每档各自读自己的点路径与刻度」
      if ((req.url ?? "").startsWith("/half")) {
        res.end(JSON.stringify({ data: { prob: raw / 100 } })); // 0-1 刻度
      } else {
        res.end(JSON.stringify({ data: { prob: raw } }));
      }
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
    expect(seen[0]).toContain(SAMPLE); // 第一次送的是原文（seen 里带上了请求路径前缀）
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

  /**
   * v0.9.71：`--detector-url` 可重复 —— 同一篇稿子逐档送检，做跨厂商横向对比。
   * 关键点不只是"送了几次"，而是**每档各自读自己的点路径与刻度**（0-100 vs 0-1 混用时不能串味）。
   */
  it("多档检测器：逐档送检，各自按本档的点路径与刻度取分", async () => {
    const dir = tmpDir();
    const input = path.join(dir, "m.txt");
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
        // 第 1 档：0-100 刻度
        "--detector-url",
        `http://127.0.0.1:${port}/a`,
        "--detector-path",
        "data.prob",
        // 第 2 档：0-1 刻度（同一台服务器，按路径区分）
        "--detector-url",
        `http://127.0.0.1:${port}/half`,
        "--detector-path",
        "data.prob",
        "--detector-scale",
        "0-1",
      ],
      { cwd: ROOT, timeout: 120_000 },
    );

    // 2 档 × (原文 + 产出) = 4 次送检
    expect(seen.length, "两档检测器应各送原文与产出").toBe(4);
    expect(stdout).toContain("#1");
    expect(stdout).toContain("#2");

    const rep = JSON.parse(fs.readFileSync(report, "utf-8")) as {
      reports: {
        detectorScores?: { url: string; before: number | null; after: number | null }[];
      }[];
    };
    const scores = rep.reports[0].detectorScores ?? [];
    expect(scores).toHaveLength(2);
    expect(scores[0].url).toContain("/a");
    expect(scores[1].url).toContain("/half");
    // 0-1 档返回的是小数，但 extractScore 会按刻度折成 0~100 —— 两档都应落在 0~100
    for (const row of scores) {
      expect(row.before).toBeGreaterThanOrEqual(0);
      expect(row.before).toBeLessThanOrEqual(100);
      expect(row.after).toBeGreaterThanOrEqual(0);
      expect(row.after).toBeLessThanOrEqual(100);
    }
  }, 120_000);
});
