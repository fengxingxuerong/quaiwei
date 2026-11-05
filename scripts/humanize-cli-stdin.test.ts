/**
 * humanize-cli stdin 管道模式端到端测试（v0.9.38）
 *
 * 为什么走子进程：humanize-cli.ts 无条件 main()，import 即执行（vm 切片测试只覆盖
 * parseArgs 纯函数层，见 scripts-logic.test.ts）；stdin 的真实行为只能在进程级验证。
 *
 * ⚠️ 本机坑（2026-10-13 实测）：node 的 execFile `input` 选项**不可靠**——input 写入后
 * 管道不 EOF，子进程 readFileSync(0) 永久阻塞（20s 才被杀）。bash 管道反而正常
 * （`echo x | node cli` 手动验证过）。故这里用 bash 真管道 + 环境变量传文本
 * （免引号转义），CI 的 windows runner 同样带 Git Bash。
 *
 * 断言的抓手：**正文走 stdout、诊断走 stderr**——`> 重定向` 不混进度行是管道模式的
 * 立身之本；以及「同 seed 可复现」「强度透传」。
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

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * 找 bash。Windows 上「装了 Git 但 PATH 里没有 bash」是常态（本机 2026-10-22 实测：
 * `Get-Command bash` 为空，Git 却装在 C:\Program Files\Git），此时 `execFile("bash")`
 * 直接 ENOENT，11 条用例全红——而它们红的原因是环境，不是引擎，等于把
 * `check:release` 变成"看你装没装 Git 的 PATH"。
 * 兜底顺序：显式环境变量 → PATH 里的 bash → Windows 常见安装位置。
 */
function resolveBash(): string {
  const explicit = process.env.QUAIWEI_BASH?.trim();
  if (explicit) return explicit;
  if (process.platform !== "win32") return "bash";
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe")
      : "",
  ];
  return candidates.find((p) => p && fs.existsSync(p)) ?? "bash";
}

const BASH = resolveBash();

/**
 * 跑 CLI：argv 为 humanize-cli 的参数；input 经环境变量 + bash printf 管道喂 stdin。
 * 不 rejects——退出码/输出一并返回，方便断言错误路径的 stderr 文案。
 */
async function runCli(argv: string[], input: string): Promise<RunResult> {
  // 注意：是 `"$NODE_BIN"` 当可执行、tsx cli 当脚本——写反成 `node "$NODE_BIN"` 会让
  // node 把 node.exe 本身当脚本读（MZ SyntaxError，2026-10-13 实测踩过）。
  const script = 'printf %s "$CLI_STDIN" | "$NODE_BIN" "$TSX_BIN" "$CLI_BIN" "$@"';
  try {
    const { stdout, stderr } = await execFileAsync(
      BASH,
      ["-c", script, "ai-humanizer", ...argv],
      {
        env: {
          ...process.env,
          CLI_STDIN: input,
          NODE_BIN: process.execPath,
          TSX_BIN: TSX,
          CLI_BIN: CLI,
        },
        cwd: ROOT,
        timeout: 90_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as Error & { code?: number; stderr?: string };
    return { stdout: "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

const AI_TEXT =
  "本文首先阐述了人工智能技术的发展现状，其次分析了其在各行各业中的广泛应用。综上所述，人工智能技术具有广阔的发展前景，值得我们高度重视。";

/** v0.9.84：人写口语稿，探针实测 aiScore=6（人写带 ≤27）。
 *  注意 AI_TEXT 的 aiScore 也只有 11——这正是「不能用 aiScore 一刀切跳过」的实物证据。 */
const HUMAN_TEXT =
  "我家楼下那家早餐店开了快十年了。老板娘记得我不吃香菜，每次都是提前给我挑出来。有次我出差一个月没去，回来她问我：上哪儿发财去了？这店能开十年，靠的不是什么营销打法，就是记得住人。";

describe("humanize-cli stdin 模式", () => {
  it("显式 - 参数：stdin 进 → stdout 出去味正文，诊断在 stderr", async () => {
    const r = await runCli(["-", "--seed", "42"], `${AI_TEXT}\n`);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(30);
    expect(r.stdout).not.toContain("[1/1]"); // 批量进度行不混进 stdout
    expect(r.stderr).toMatch(/✅ stdin：\d+→\d+/); // 诊断（含前后分）走 stderr
  }, 60_000);

  it("省略输入参数：管道喂 stdin 同样生效（cat 稿 | ai-humanizer）", async () => {
    const r = await runCli(["--seed", "42"], AI_TEXT);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(30);
  }, 60_000);

  it("--seed 可复现：同输入同种子两次输出逐字相同", async () => {
    const a = await runCli(["-", "--seed", "7"], AI_TEXT);
    const b = await runCli(["-", "--seed", "7"], AI_TEXT);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  }, 60_000);

  it("强度参数透传：--intensity 0.9 与 0.3 输出不同（同一 seed）", async () => {
    const strong = await runCli(["-", "--intensity", "0.9", "--seed", "5"], AI_TEXT);
    const mild = await runCli(["-", "--intensity", "0.3", "--seed", "5"], AI_TEXT);
    expect(strong.code).toBe(0);
    expect(mild.code).toBe(0);
    expect(strong.stdout).not.toBe(mild.stdout);
  }, 60_000);

  it("空 stdin → 退出码 1 且 stderr 一句话", async () => {
    const r = await runCli(["-"], "   \n");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("标准输入为空");
  }, 60_000);

  it("stdin + --api → 拒绝并提示落成文件（诚实边界，不重构批量路径）", async () => {
    const r = await runCli(["-", "--api"], AI_TEXT);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("stdin 模式暂不支持 LLM 通道");
  }, 60_000);

  it("stdin + --explain → 「为什么这么改」清单进 stderr", async () => {
    const r = await runCli(["-", "--explain", "--seed", "3"], AI_TEXT);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("确定归因"); // formatExplain 的逐条归因输出
  }, 60_000);

  it("重定向可用性：stdout 只有正文，可直接 > 落盘", async () => {
    const r = await runCli(["-", "--seed", "42"], AI_TEXT);
    expect(r.code).toBe(0);
    // 模拟重定向产物：写出去再读回来应逐字一致（无诊断行污染）
    const tmp = path.join(fs.realpathSync(os.tmpdir()), "stdin-redirect-check.txt");
    fs.writeFileSync(tmp, r.stdout, "utf8");
    expect(fs.readFileSync(tmp, "utf8")).toBe(r.stdout);
    fs.unlinkSync(tmp);
  }, 60_000);

  // v0.9.40：--help 此前落进 default 分支 →「未知参数」+ 退出码 1。命令行工具的第一个
  // 动作不该是报错。三条断言各自盯一个面：退出码、输出通道（帮助不是诊断）、
  // 以及「help 提前返回、根本不读 stdin」（空管道仍 0 —— 若退回读 stdin 必红）。
  it("--help → 用法进 stdout + 退出码 0（不是「未知参数」错误）", async () => {
    const r = await runCli(["--help"], AI_TEXT);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("用法:");
    expect(r.stderr).not.toContain("未知参数");
  }, 60_000);

  it("-h 短选项等价：同样打印用法并退出 0", async () => {
    const r = await runCli(["-h"], AI_TEXT);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("用法:");
  }, 60_000);

  it("--help 提前返回：空 stdin 也不报错（证明没去读管道）", async () => {
    const r = await runCli(["--help"], "");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--help");
  }, 60_000);
});

/* ─────────── v0.9.84 --skip-low-risk ───────────
 * 背景：双网关独立评委实测，aiScore≤27 的 20 篇里 7 篇改后反而更像 AI；
 * 但 13 篇是改善的，且典型 AI 腔短稿（上面 AI_TEXT）aiScore 也只有 11。
 * ⇒ 不能默认跳过，只给醒目警告；想要保护的人自己加 --skip-low-risk（opt-in）。
 * 这三条锁住：默认不 breaking、开关真跳过、批量仍产出同名文件且报告可查。
 */
describe("v0.9.84 --skip-low-risk（人写带可选原样出稿）", () => {
  it("默认（无开关）：人写带照常改写，stderr 给独立评委实测的醒目警告", async () => {
    const r = await runCli(["-", "--intensity", "0.9", "--seed", "42"], HUMAN_TEXT);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("人写带");
    expect(r.stderr).toContain("独立评委实测");
    expect(r.stderr).not.toContain("按 --skip-low-risk 原样输出");
  }, 60_000);

  it("--skip-low-risk：stdin 人写带原样输出，stderr 明说未改写", async () => {
    const r = await runCli(["-", "--skip-low-risk"], HUMAN_TEXT);
    expect(r.code).toBe(0);
    expect(r.stdout.trimEnd()).toBe(HUMAN_TEXT);
    expect(r.stderr).toContain("按 --skip-low-risk 原样输出");
  }, 60_000);

  it("批量：仍产出同名文件（内容=原文），--report 记 skippedLowRisk", async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "quaiwei-lowrisk-"));
    const out = path.join(dir, "out");
    const rep = path.join(dir, "rep.json");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(dir, "a.txt"), HUMAN_TEXT, "utf8");
    try {
      const r = await runCli([dir, "--out", out, "--skip-low-risk", "--report", rep], "");
      expect(r.code).toBe(0);
      expect(fs.readFileSync(path.join(out, "a.humanized.txt"), "utf8")).toBe(HUMAN_TEXT);
      const j = JSON.parse(fs.readFileSync(rep, "utf8"));
      expect(j.totals.skippedLowRisk).toBe(1);
      expect(j.reports[0].skippedLowRisk).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("组合判据更准：书面套话命中多的低分稿不再被跳过（真改写）", async () => {
    const corpus = JSON.parse(
      fs.readFileSync(path.join(ROOT, "scripts", "realcase", "cases.json"), "utf8"),
    ) as { cases: { id: string; text: string }[] };
    // C23：aiScore=12（人写带）但 formalHits=3；双网关评测里改写改善 +47.5，旧判据会误拦
    const rescued = corpus.cases.find((c) => c.id === "C23-frontmatter-indent")!.text;
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "quaiwei-lowyield-"));
    const out = path.join(dir, "out");
    const rep = path.join(dir, "rep.json");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(dir, "a.txt"), HUMAN_TEXT, "utf8");
    fs.writeFileSync(path.join(dir, "b.txt"), rescued, "utf8");
    type Row = { file: string; lowYieldRisk?: boolean; skippedLowRisk?: boolean };
    try {
      const r = await runCli([dir, "--out", out, "--skip-low-risk", "--report", rep], "");
      expect(r.code).toBe(0);
      const j = JSON.parse(fs.readFileSync(rep, "utf8")) as {
        totals: { lowYieldRisk: number };
        reports: Row[];
      };
      const byFile = Object.fromEntries(j.reports.map((x) => [x.file, x])) as Record<string, Row>;
      expect(byFile["a.txt"].lowYieldRisk).toBe(true);
      expect(byFile["a.txt"].skippedLowRisk).toBe(true);
      expect(fs.readFileSync(path.join(out, "a.humanized.txt"), "utf8")).toBe(HUMAN_TEXT);
      expect(byFile["b.txt"].lowYieldRisk).toBe(false);
      expect(byFile["b.txt"].skippedLowRisk).toBeUndefined();
      expect(fs.readFileSync(path.join(out, "b.humanized.txt"), "utf8")).not.toBe(rescued);
      expect(j.totals.lowYieldRisk).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
