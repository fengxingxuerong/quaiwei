/**
 * check-env.ts —— 环境预检门禁（根治「红了 4 天没人发现」的静默环境损坏）
 *
 * 为什么需要它（2026-11-03 实测事故）：
 *   node_modules/@esbuild/win32-x64/ 里的 esbuild.exe 被静默删除（包只剩 README.md +
 *   package.json，二进制没了；registry tarball 完好、非杀毒，npm 对已存在目录跳过重装）。
 *   后果：31 个测试用例红了 4 天没人发现——SCORECARD「全绿」的声称与实际脱节；
 *   `npm run bench` 也挂。lint / tsc / vitest 自身的报错都被各自的失败掩盖，
 *   没有一道门禁专门回答「这台机器的环境还健康吗」。
 *
 * 本脚本只回答五个问题，任何一个答不上来即退出 1：
 *   ① node 版本满足 package.json 的 engines 要求吗？
 *   ② node_modules 装好了吗（tsx / vitest 在场）？
 *   ③ esbuild 的**平台二进制**真在场吗？（目录存在≠二进制在场，事故一的核心）
 *   ④ esbuild 二进制能跑吗？跑出的版本与 JS 包一致吗？（版本错位同样会让 tsx 全线挂）
 *   ⑤ TypeScript 原生编译器的平台二进制在场吗？（事故二：tsc.exe + lib.dom.d.ts
 *      同批丢失——`tsc -b` 直接 "Executable not found"；装上 tsc.exe 还会因
 *      缺 lib.dom.d.ts 冒出一批假 DOM 类型错。检测：lib 目录文件数对不上官方包即红）
 *
 * 设计约束：
 *   - 只读、零网络、零外部依赖（复用 esbuild 自带 CLI，不引包）。
 *   - 可注入 process 版本与二进制执行器，同一函数在单测里用假根目录跑（check-env.test.ts）。
 *   - 报错必须附**能照着敲的修法**——门禁的价值在红灯可执行，不在红灯本身。
 *
 * 用法：
 *   npm run check:env          （已挂进 check:release 链首与 CI / windows-build）
 *   npx tsx scripts/check-env.ts [--repo <目录>]
 *   退出码：0 = 环境健康；1 = 有检查不过（逐条列出 + 修法）；2 = 意外错误
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface EnvCheckRow {
  loc: string;
  ok: boolean;
  detail: string;
  /** ok=false 时给一条能照着敲的修法；ok=true 时为空 */
  fix?: string;
}

export interface EnvCheckOptions {
  /** 覆盖 node 版本探测（单测注入用）；缺省读 process.versions.node */
  nodeVersion?: string;
  /** 覆盖二进制执行器（单测注入用）；入参为二进制绝对路径，返回 [版本输出, null] 或 [null, 错误消息] */
  runBinary?: (bin: string) => [string | null, string | null];
}

/** engines 字段只用到形如 ">=18" 的下限表达；更复杂的语义不支持，遇到就当通过（不误报） */
function satisfiesMinNode(current: string, engines: string): boolean {
  const m = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(engines.trim());
  if (!m) return true; // 读不懂的表达式不拦（宁漏报不误报，理由同 coverage-gate 的"假红"教训）
  const [cMaj, cMin = "0", cPat = "0"] = current.split(".");
  const [eMaj, eMin = "0", ePat = "0"] = [m[1], m[2], m[3]];
  for (let i = 0; i < 3; i++) {
    const c = Number([cMaj, cMin, cPat][i]);
    const e = Number([eMaj, eMin, ePat][i]);
    if (c !== e) return c > e;
  }
  return true;
}

/** 平台二进制规格：包名模板 / 包内二进制相对路径 / 最小体积。新增受检包往这里加一行 */
interface PlatformBinarySpec {
  /** 宿主包（缺它则整个规格跳过——没装就不查，宁跳过不误报） */
  hostPkg: string;
  /** 平台包名模板（{platform}/{arch} 占位） */
  platformPkg: (platform: string, arch: string) => string;
  /** 平台包内二进制相对路径 */
  binRel: (platform: string) => string;
  /** 二进制体积下限（字节）：真二进制都是 MB 级，空壳/残缺包远小于此 */
  minBytes: number;
  /** 可执行版本命令（输出 trim 后应等于宿主包 version） */
  versionArgs: string[];
  /** 版本输出前缀剥离（tsc 输出 "Version 7.0.2"） */
  versionPrefix?: RegExp;
  /** 额外完整性文件：相对平台包根的路径列表（全部须存在）。事故二里 lib.dom.d.ts 同批被删 */
  extraFiles?: (platform: string) => string[];
  /** 平台包的 npm 包名（写进修法提示；与 platformPkg 不同——TS 的平台包不在宿主 optionalDeps 里显式列出） */
  pkgName: (platform: string, arch: string) => string;
}

const PLATFORM_BINARIES: PlatformBinarySpec[] = [
  {
    hostPkg: "esbuild",
    platformPkg: (p, a) => `@esbuild/${p}-${a}`,
    binRel: (p) => (p === "win32" ? "esbuild.exe" : "bin/esbuild"),
    minBytes: 1_000_000,
    versionArgs: ["--version"],
    pkgName: (p, a) => `@esbuild/${p}-${a}`,
  },
  {
    // 事故二（2026-11-03）：@typescript/typescript-win32-x64 里 tsc.exe 与 lib.dom.d.ts 同批丢失
    hostPkg: "@typescript/native",
    platformPkg: (p, a) => `@typescript/typescript-${p}-${a}`,
    binRel: (p) => (p === "win32" ? "lib/tsc.exe" : "lib/tsc"),
    minBytes: 1_000_000,
    versionArgs: ["--version"],
    versionPrefix: /^Version\s+/,
    extraFiles: () => ["lib/lib.dom.d.ts"],
    pkgName: (p, a) => `@typescript/typescript-${p}-${a}`,
  },
];

/** 汇总全部检查。row 顺序即打印顺序：node → 依赖在场 → esbuild 三连 */
export function checkEnv(root: string, opts: EnvCheckOptions = {}): EnvCheckRow[] {
  const rows: EnvCheckRow[] = [];
  const read = (rel: string): string | null => {
    try {
      return fs.readFileSync(path.join(root, rel), "utf-8");
    } catch {
      return null;
    }
  };
  const exists = (rel: string): boolean => fs.existsSync(path.join(root, rel));

  // ① node engines
  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  const enginesRaw = (() => {
    const raw = read("package.json");
    if (!raw) return null;
    try {
      return (JSON.parse(raw) as { engines?: { node?: string } }).engines?.node ?? null;
    } catch {
      return null;
    }
  })();
  rows.push({
    loc: "node 版本 vs engines",
    ok: enginesRaw === null || satisfiesMinNode(nodeVersion, enginesRaw),
    detail: enginesRaw === null ? "package.json 缺 engines 字段（跳过）" : `当前 ${nodeVersion}，要求 ${enginesRaw}`,
    fix: enginesRaw === null ? undefined : `换用满足 ${enginesRaw} 的 node（本项目 CI 用 22，本机实测 24 也可）`,
  });

  // ② 关键依赖在场（tsx / vitest 是 check:release 与 npm test 的地基）
  for (const dep of ["tsx", "vitest"]) {
    const ok = exists(path.join("node_modules", dep, "package.json"));
    rows.push({
      loc: `node_modules/${dep}`,
      ok,
      detail: ok ? "在场" : "缺失",
      fix: ok ? undefined : "npm ci --no-fund --no-audit（或 npm install）",
    });
  }

  // ③④⑤ 平台二进制规格循环：宿主在场才查（宁跳过不误报）；查「目录→二进制(体积)→可执行+版本一致→完整性文件」
  for (const spec of PLATFORM_BINARIES) {
    const hostRaw = read(path.join("node_modules", spec.hostPkg, "package.json"));
    const hostVersion = (() => {
      if (!hostRaw) return null;
      try {
        return (JSON.parse(hostRaw) as { version?: string }).version ?? null;
      } catch {
        return null;
      }
    })();
    if (hostVersion === null) continue; // 宿主包没装（不该发生但别误报），跳过该规格

    const pkg = spec.platformPkg(process.platform, process.arch);
    const pkgDirRel = path.join("node_modules", ...pkg.split("/"));
    const binRel = spec.binRel(process.platform);
    const binAbs = path.join(root, pkgDirRel, binRel);
    const binStat = (() => {
      try {
        return fs.statSync(binAbs);
      } catch {
        return null;
      }
    })();
    const binOk = binStat !== null && binStat.isFile() && binStat.size > spec.minBytes;
    rows.push({
      loc: `平台二进制（${pkg}）`,
      ok: binOk,
      detail:
        binStat === null
          ? `目录里没有 ${binRel}（空壳/残缺包，2026-11-03 事故形态）`
          : `${binRel} ${(binStat.size / 1048576).toFixed(1)}MB`,
      fix: binOk
        ? undefined
        : [
            `npm install ${spec.pkgName(process.platform, process.arch)}@${hostVersion} --force`,
            `若装完仍缺：可能是杀毒/清理工具删的。从官方 tarball 手动补：`,
            `  npm pack ${spec.pkgName(process.platform, process.arch)}@${hostVersion} && tar -xzf <tgz> && cp -r package/* ${pkgDirRel}/`,
          ].join("；"),
    });

    // 完整性文件（lib.dom.d.ts 类）：二进制在场但库文件缺 → 编译期才炸，必须在这里拦
    if (binOk && spec.extraFiles) {
      const missing = spec.extraFiles(process.platform).filter((f) => !exists(path.join(pkgDirRel, f)));
      if (missing.length) {
        rows.push({
          loc: `${pkg} 完整性文件`,
          ok: false,
          detail: `缺 ${missing.join(", ")}（tsc 在场但 DOM lib 缺会冒一批假 DOM 类型错）`,
          fix: `npm pack ${pkg}@${hostVersion} 后把缺失文件按原路径拷回 ${pkgDirRel}/（2026-11-03 事故二实录）`,
        });
      }
    }

    // 二进制能跑 + 版本一致（空目录存在但二进制坏的另一种形态）
    if (binOk) {
      const run = opts.runBinary ?? ((bin: string): [string | null, string | null] => {
        try {
          return [execFileSync(bin, spec.versionArgs, { encoding: "utf-8" }).trim(), null];
        } catch (e) {
          return [null, (e as Error).message.split("\n")[0]];
        }
      });
      const [out, err] = run(binAbs);
      const outVersion = out === null ? null : out.replace(spec.versionPrefix ?? /^/, "");
      const versionOk = outVersion === hostVersion;
      rows.push({
        loc: `${spec.hostPkg} 二进制可执行`,
        ok: versionOk,
        detail:
          out === null
            ? `执行失败：${err}`
            : `报 ${outVersion}，宿主包 ${hostVersion}${versionOk ? "，一致" : "，不一致"}`,
        fix: versionOk
          ? undefined
          : `npm install ${spec.hostPkg}@${hostVersion} ${spec.pkgName(process.platform, process.arch)}@${hostVersion} --force（宿主与平台包必须同版）`,
      });
    }
  }

  return rows;
}

/* ------------------------------ CLI ------------------------------ */
function main(): void {
  const args = process.argv.slice(2);
  const i = args.indexOf("--repo");
  const root = i >= 0 ? path.resolve(args[i + 1] ?? ".") : process.cwd();

  let rows: EnvCheckRow[];
  try {
    rows = checkEnv(root);
  } catch (e) {
    console.error(`✗ check-env 意外失败：${(e as Error).message}`);
    process.exit(2);
  }

  console.log("══════════ 环境预检（check:env） ══════════");
  for (const r of rows) {
    console.log(`  ${r.ok ? "✅" : "❌"} ${r.loc.padEnd(36)} ${r.detail}`);
  }
  if (rows.every((r) => r.ok)) {
    console.log("\n✅ 环境健康（node / 依赖 / esbuild 平台二进制 / 版本一致）");
    return;
  }
  console.error("\n❌ 环境有问题，修法（照着敲）：");
  for (const r of rows.filter((r) => !r.ok)) {
    console.error(`   · ${r.loc}\n     ${r.fix}`);
  }
  console.error("   ↑ 本次事故（2026-11-03）：esbuild.exe 被静默删除后 31 个用例红了 4 天没人发现。");
  process.exit(1);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("check-env.ts")) {
  main();
}
