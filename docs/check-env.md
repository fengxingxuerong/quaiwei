# 环境预检 `check:env`（v0.9.82）

> 类型：当前口径。改了 `scripts/check-env.ts` 就同步改这份。
> 一句话：跑门禁之前先回答「这台机器的环境还健康吗」，别让环境损坏伪装成代码缺陷。

## 1. 为什么有这道闸

**事故一（2026-11-03）**：`node_modules/@esbuild/win32-x64/` 里的 `esbuild.exe` 被静默删除。
包里 `package.json` 和 `README.md` 都还在，只有二进制没了（registry tarball 完好、不是杀毒，
`npm install` 对已存在目录直接跳过重装）。后果：**31 个用例红了 4 天没人发现**——
`tsc` / `vitest` 的报错是"加载失败"，被各自的失败掩盖，没人往"环境坏了"想。

**事故二（同日）**：`@typescript/typescript-win32-x64` 的 `tsc.exe` 与 `lib/lib.dom.d.ts`
同批丢失。装上 `tsc.exe` 之后又冒出一批**假的 DOM 类型错**——因为缺 `lib.dom.d.ts`。

两次都不是代码问题，但都会让"全绿/全红"的结论失去意义。这道闸的价值就一句话：
**先排除环境，再谈代码。**

## 2. 它只回答五个问题

| # | 检查 | 判据 | 为什么容易漏 |
|---|---|---|---|
| ① | node 版本 vs `engines` | 解析 `>=X.Y.Z` 下限 | 只认简单下限表达式，读不懂的不拦（宁漏报不误报） |
| ② | `tsx` / `vitest` 在场 | `node_modules/<dep>/package.json` 存在 | `check:release` 与 `npm test` 的地基 |
| ③ | esbuild **平台二进制**在场 | 目录里有 `esbuild.exe` 且 **> 1MB** | **目录存在 ≠ 二进制在场**，这是事故一的核心 |
| ④ | 二进制可执行且版本一致 | 跑 `--version`，与宿主包 `version` 比对 | 版本错位一样会让 `tsx` 全线挂 |
| ⑤ | TS 原生编译器完整 | `lib/tsc.exe` 在场 + `lib/lib.dom.d.ts` 在场 | 少了后者会冒一批假 DOM 类型错 |

**宿主包没装就跳过该规格**（宁跳过不误报）——`package.json` 缺 `engines` 同理，按通过处理。

## 3. 怎么用

```bash
npm run check:env            # 挂进门禁后一般不用手敲
npx tsx scripts/check-env.ts --repo <目录>   # 指到别的仓库/副本
```

退出码：`0` 健康 · `1` 有检查不过（逐条列红灯 + 修法）· `2` 意外错误。

健康时输出：

```
══════════ 环境预检（check:env） ══════════
  ✅ node 版本 vs engines       当前 22.22.2，要求 >=18
  ✅ node_modules/tsx          在场
  ✅ node_modules/vitest       在场
  ✅ 平台二进制（@esbuild/win32-x64）  esbuild.exe 11.2MB
  ✅ esbuild 二进制可执行        报 0.28.2，宿主包 0.28.2，一致
✅ 环境健康（node / 依赖 / esbuild 平台二进制 / 版本一致）
```

红灯必须**能照着敲**——这是设计约束，不是文案偏好：

```
❌ 平台二进制（@esbuild/win32-x64）  目录里没有 esbuild.exe（空壳/残缺包）
   修法：npm install @esbuild/win32-x64 --force；若 npm 跳过重装，
        用 npm pack @esbuild/win32-x64 解包后手工放回 node_modules/
```

## 4. 挂在哪

- `check:release` **链首**（`npm run check:release` 第一个跑它）：不过闸就别往下跑了，
  省得红出一片无关失败。
- CI（`.github/workflows/ci.yml`）在 `npm ci` 之后、`tsc` 之前。
- Windows 构建流程同样插入。

## 5. 自证

`scripts/check-env.test.ts` 有 9 条用例，其中一条是**真仓库自证**：
在真实仓库根跑 `checkEnv()`，任何一行红就说明这台机器的环境真的坏了。

⚠️ 这条用例取仓库根**不能用 `process.cwd()`**：`coverage-gate.ts` 是用
`cwd: os.tmpdir()` 起 vitest 的（本机能跑通全量的前提），此时 cwd 是临时目录，
会找不到 `node_modules/tsx` 判红——门禁永久假红。正解是
`path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")`，与其他测试同一写法。

## 6. 边界

- 只覆盖"平台二进制缺失/错位/不完整"这一类事故，**不替代** `tsc`、`eslint`、单测。
- 只读、零网络、零外部依赖（复用 esbuild 自带 CLI，不引包）。
- 新增受检包：往 `check-env.ts` 的 `PLATFORM_BINARIES` 加一行
  （宿主包名 / 平台包模板 / 二进制相对路径 / 体积下限 / 版本命令 / 额外完整性文件）。
