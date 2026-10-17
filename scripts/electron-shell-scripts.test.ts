/**
 * electron-app 壳层脚本的测试（2026-10-17 补）
 *
 * ## 为什么补这个文件
 *
 * 壳层共 971 行、零测试：`main.js` 228 / `preload.js` 34 / `ppl-engine.cjs` 195 /
 * `rebuild-app.cjs` 209 / `prune-dist.cjs` 103 / `verify-pruned.cjs` 202，3 个 IPC 通道。
 * 它是**每一次发版的必经路径**，而这两个月里踩的坑全在这条路上：
 * `app.stale-*` 残留、产物落后 7 个提交、随包文档停在 v0.8.2、带 Key 的包差点发公开版……
 * 每次都靠人眼对 `resources/` 目录，靠不住。
 *
 * ## 覆盖边界（诚实说明，别以为它管得多）
 *
 * 覆盖：
 *   · `prune-dist.cjs` —— dry-run 零改动、真删的取舍、目标缺失跳过、目录不存在报错
 *   · `verify-pruned.cjs` —— 三条硬判据（缺文件 / 版本不一致 / 无 build-info）确实会红
 *   · `rebuild-app.cjs` —— 两条前置检查（缺目录 / 缺运行时文件）
 *   · 安全基线 —— webPreferences 三件套、preload 暴露面、IPC 通道名双向对得上
 *
 * 不覆盖（以及为什么）：
 *   · 真跑 `rebuild-app` 的全流程 —— 它 `execSync("npm ls")` + 拷 300MB 依赖，
 *     一次几十秒，还会改真实 `electron-dist/`。这类断言交给发版后跑 `verify-pruned`。
 *   · 真起 Electron 窗口 —— 要 GUI session，CI 里起不来。
 *   · `ppl-engine.cjs` 的模型推理 —— 要下载 99MB 权重。
 *
 * ## 用法注意（本机）
 * 同步 `spawn` 在部分宿主下恒 EBUSY（见 `scripts/run-async.ts` 头部），所以这里
 * 一律用 promisify 后的**异步** `execFile`。
 */
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(ROOT, "electron-app");
const NODE = process.execPath;

interface ShellRun {
  code: number;
  out: string;
}

/** 起子进程跑壳层脚本；不 reject，退出码与 stdout+stderr 一起返回 */
async function runScript(file: string, argv: string[]): Promise<ShellRun> {
  // ⚠️ 输出里的路径必须归一：脚本用 `path.relative()` 打印，Windows 下是反斜杠
  // （`resources\app\main.js`），直接按 POSIX 形式断言会永远匹配不上。
  const norm = (s: string) => s.replace(/\\/g, "/");
  try {
    const { stdout, stderr } = await execFileAsync(NODE, [path.join(APP_DIR, file), ...argv], {
      cwd: ROOT,
      timeout: 90_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, out: norm(`${stdout}${stderr}`) };
  } catch (e) {
    const err = e as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    return {
      // code 可能是数字（退出码）或字符串（ENOENT 等派生失败）——后者记 -1，
      // 免得把"进程没起来"读成"脚本判红"
      code: typeof err.code === "number" ? err.code : -1,
      out: norm(`${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`),
    };
  }
}

/** 造一棵假的 electron-dist 树；返回 dist 目录 */
function makeDist(
  entries: Array<{ rel: string; content?: string }>,
  name = "QuAiWei-win32-x64",
): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "quaiwei-shell-"));
  const dist = path.join(base, name);
  fs.mkdirSync(dist, { recursive: true });
  for (const { rel, content } of entries) {
    const p = path.join(dist, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content ?? "x", "utf8");
  }
  return dist;
}

/** 裁剪脚本关心的最小可判定结构 */
function pruneFixture(): string {
  return makeDist([
    // 应当被删
    { rel: "resources/app/node_modules/onnxruntime-web/package.json", content: '{"name":"onnxruntime-web"}' },
    { rel: "resources/app/node_modules/onnxruntime-node/bin/napi-v6/linux/a.node" },
    { rel: "resources/app/node_modules/onnxruntime-node/bin/napi-v6/darwin/a.node" },
    // 必须保留
    { rel: "resources/app/node_modules/onnxruntime-node/bin/napi-v6/win32/a.node" },
    {
      rel: "resources/app/node_modules/@huggingface/transformers/package.json",
      content: '{"name":"@huggingface/transformers"}',
    },
    // 语言包：保留 zh-CN / en-US，其余删
    { rel: "locales/zh-CN.pak" },
    { rel: "locales/en-US.pak" },
    { rel: "locales/de.pak" },
    { rel: "locales/ja.pak" },
    // 非 .pak 文件不归裁剪管
    { rel: "locales/README.txt", content: "keep me" },
  ]);
}

const exists = (dist: string, rel: string) => fs.existsSync(path.join(dist, rel));

describe("prune-dist.cjs", () => {
  it("--dry-run 必须一个字节都不动（这是 dry-run 唯一的存在理由）", async () => {
    const dist = pruneFixture();
    const r = await runScript("prune-dist.cjs", ["--dry-run", "--dist", dist]);

    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("dry-run");
    // 四个目标全在
    expect(exists(dist, "resources/app/node_modules/onnxruntime-web"), r.out).toBe(true);
    expect(exists(dist, "resources/app/node_modules/onnxruntime-node/bin/napi-v6/linux")).toBe(true);
    expect(exists(dist, "resources/app/node_modules/onnxruntime-node/bin/napi-v6/darwin")).toBe(true);
    expect(exists(dist, "locales/de.pak")).toBe(true);
  });

  it("真跑：删掉应删的，留下 win32 二进制与两个语言包，非 .pak 文件不动", async () => {
    const dist = pruneFixture();
    const r = await runScript("prune-dist.cjs", ["--dist", dist]);

    expect(r.code, r.out).toBe(0);

    expect(exists(dist, "resources/app/node_modules/onnxruntime-web"), r.out).toBe(false);
    expect(exists(dist, "resources/app/node_modules/onnxruntime-node/bin/napi-v6/linux")).toBe(false);
    expect(exists(dist, "resources/app/node_modules/onnxruntime-node/bin/napi-v6/darwin")).toBe(false);

    expect(exists(dist, "resources/app/node_modules/onnxruntime-node/bin/napi-v6/win32/a.node")).toBe(true);
    expect(exists(dist, "resources/app/node_modules/@huggingface/transformers/package.json")).toBe(true);

    expect(exists(dist, "locales/zh-CN.pak")).toBe(true);
    expect(exists(dist, "locales/en-US.pak")).toBe(true);
    expect(exists(dist, "locales/de.pak")).toBe(false);
    expect(exists(dist, "locales/ja.pak")).toBe(false);
    // 非 .pak 文件不归裁剪管，必须原样
    expect(fs.readFileSync(path.join(dist, "locales/README.txt"), "utf8")).toBe("keep me");
  });

  it("目标已不存在时跳过而不是报错（重复裁剪要幂等）", async () => {
    const dist = makeDist([{ rel: "resources/app/node_modules/onnxruntime-node/bin/napi-v6/win32/a.node" }]);
    const r = await runScript("prune-dist.cjs", ["--dist", dist]);

    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("不存在，跳过");
    expect(exists(dist, "resources/app/node_modules/onnxruntime-node/bin/napi-v6/win32/a.node")).toBe(true);
  });

  it("目录不存在时退出码非 0 并说明先打包", async () => {
    const missing = path.join(os.tmpdir(), "quaiwei-shell-不存在-" + Date.now());
    const r = await runScript("prune-dist.cjs", ["--dist", missing]);

    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("找不到打包目录");
  });
});

describe("verify-pruned.cjs", () => {
  it("空壳产物必须判红，并逐项点名缺了什么", async () => {
    const dist = makeDist([
      // 版本故意与仓库根不一致 → 触发版本判据
      { rel: "resources/app/package.json", content: JSON.stringify({ name: "quaiwei", version: "0.0.1" }) },
      { rel: "locales/zh-CN.pak" },
    ]);

    const r = await runScript("verify-pruned.cjs", ["--dist", dist]);

    expect(r.code, r.out).toBe(1);
    // 必须保留项被点名
    expect(r.out).toContain("缺失：resources/app/main.js");
    expect(r.out).toContain("缺失：resources/app/preload.js");
    // 版本判据真的跑了（而不是被前面的失败短路掉）
    const rootVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
    expect(r.out).toContain("版本不一致");
    expect(r.out).toContain(`0.0.1`);
    expect(r.out).toContain(rootVersion);
    // 新鲜度判据真的跑了
    expect(r.out).toContain("build-info.json");
    // 最后必须给出"不要发布"的结论
    expect(r.out).toContain("不要发布");
  });

  it("已裁剪的残留项必须报出来（不能只查缺失、不查该删的没删）", async () => {
    const dist = makeDist([
      { rel: "resources/app/node_modules/onnxruntime-web/package.json", content: "{}" },
      { rel: "resources/app/node_modules/onnxruntime-node/bin/napi-v6/linux/a.node" },
    ]);

    const r = await runScript("verify-pruned.cjs", ["--dist", dist]);

    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("仍存在：resources/app/node_modules/onnxruntime-web");
    expect(r.out).toContain("仍存在：resources/app/node_modules/onnxruntime-node/bin/napi-v6/linux");
  });
});

describe("rebuild-app.cjs 前置检查", () => {
  it("产物底座不存在时退出码非 0", async () => {
    const missing = path.join(os.tmpdir(), "quaiwei-shell-无底座-" + Date.now());
    const r = await runScript("rebuild-app.cjs", ["--dist", missing]);

    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("找不到");
  });

  it("底座目录存在但缺运行时文件时点名缺哪个", async () => {
    const dist = makeDist([{ rel: "resources/app/main.js" }]); // 没有 QuAiWei.exe / icudtl.dat
    const r = await runScript("rebuild-app.cjs", ["--dist", dist]);

    expect(r.code, r.out).toBe(1);
    // 只断言第一条即可：三条缺文件检查是同一个循环，逐条点名没必要
    expect(r.out).toContain("运行时文件缺失：QuAiWei.exe");
  });
});

/* ------------------------------------------------------------------ *
 * 安全基线：这些是"改了就出事、但单看代码看不出来"的契约，用源码断言钉死。
 * ------------------------------------------------------------------ */
describe("electron 安全基线", () => {
  const main = fs.readFileSync(path.join(APP_DIR, "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(APP_DIR, "preload.js"), "utf8");
  const pplEngine = fs.readFileSync(path.join(APP_DIR, "ppl-engine.cjs"), "utf8");

  it("webPreferences 三件套不得被改回不安全值", () => {
    expect(main, "contextIsolation 必须为 true").toMatch(/contextIsolation:\s*true/);
    expect(main, "nodeIntegration 必须为 false").toMatch(/nodeIntegration:\s*false/);
    expect(main, "sandbox 必须为 true").toMatch(/sandbox:\s*true/);
  });

  it("preload 不得把 ipcRenderer 裸对象交给页面", () => {
    // 只允许经 contextBridge 暴露**具体方法**；一旦有人图省事写
    // exposeInMainWorld("ipcRenderer", ipcRenderer)，渲染进程就拿到了任意通道的通行证
    expect(preload).not.toMatch(/exposeInMainWorld\(\s*["']ipcRenderer["']/);
    expect(preload).not.toMatch(/exposeInMainWorld\(\s*["']require["']/);
    expect(preload).not.toMatch(/exposeInMainWorld\(\s*["']process["']/);
  });

  it("preload 的暴露面就是这三个 namespace（改名会静默打断渲染层）", () => {
    const exposed = [...preload.matchAll(/exposeInMainWorld\(\s*["']([^"']+)["']/g)]
      .map((m) => m[1])
      .sort();
    // 期望值是独立常量，不从 preload 自己反查——否则删掉一个暴露面测试也跟着"通过"
    expect(exposed).toEqual(["ppl", "preset", "secureStore"]);
  });

  it("preload 调用的每个 invoke 通道，主进程都必须有 handler", () => {
    const invoked = [...preload.matchAll(/ipcRenderer\.invoke\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
    const handled = new Set(
      [...`${main}\n${pplEngine}`.matchAll(/ipcMain\.handle\(\s*["']([^"']+)["']/g)].map((m) => m[1]),
    );

    expect(invoked.length, "一个 invoke 都没解析到，说明 preload 的写法变了，先修测试").toBeGreaterThan(0);
    for (const ch of invoked) {
      expect(handled.has(ch), `通道 ${ch} 在 preload 里被调用，但主进程没有 ipcMain.handle`).toBe(true);
    }
  });

  it("preload 监听的每个事件通道，主进程都必须真的发", () => {
    const listened = [...preload.matchAll(/ipcRenderer\.on\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
    const sent = new Set(
      [...`${main}\n${pplEngine}`.matchAll(/\.send\(\s*["']([^"']+)["']/g)].map((m) => m[1]),
    );

    expect(listened.length).toBeGreaterThan(0);
    for (const ch of listened) {
      expect(sent.has(ch), `通道 ${ch} 被 preload 监听，但主进程/引擎里没有 .send("${ch}") —— 进度永远收不到`).toBe(
        true,
      );
    }
  });
});
