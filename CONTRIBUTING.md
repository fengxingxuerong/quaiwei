# 贡献指南

先说清楚：**提一个「这句改错了」的缺陷，比提十个功能请求更有价值。**
本项目的规则不是拍脑袋写的，每一条背后都有一个真实文本片段做锚点；改它有 regression 用例锁着。

## 一、报缺陷的正确姿势

走缺陷模板，必须带三样：**原文片段 / 实际产物 / 当时的参数**（版本 + intensity + 文风 + seed）。
本地引擎的结果依赖随机种子，同样的话在不同 seed 下不一定稳态复现——
**不给 seed 的缺陷报告基本不可用**。

涉及真实人名、金额、内部数据的片段请先改成等价假数据，我们只要语法现象。

## 二、改代码前必读（都是红的教训）

### 1. 判形态，不判体裁

这条最少踩过三次。绑 `genre` 或语体标签会被两头打穿：体裁自动判定本身
confidence 常常只有 0.5（等于抛硬币），且同体裁内部形态各异。
判据要用**文档签名**（`SPEECH_DOC_RE` / `LITIGATION_DOC_RE` 那一族）或显式风格档。

### 2. 动 VOCAB 词表 / 守卫后必须重新生成 skill 规则

```bash
npx tsx scripts/gen-skill-rules.ts          # 写盘
npx tsx scripts/gen-skill-rules.ts --check  # 只比对
```

不跑，`skill-rules.test.ts` 会红两条。

### 3. 多种子验收，别单点跑一遍

主力用例在 intensity 1.0 绿、产品默认 0.9 档漏，是常态。**验收只看实际产出，不看表**：

```bash
npx tsx scripts/realcase/run.ts      # 23 篇真实语料，约 3 秒
```

**别拿一次抽样当结论**（2026-10-24 教训）：aiScore 这类指标在同一条代码上跨种子能摆动
4~13 分（`docs` 里那些「分突然变差」多半是这个）。`test:regress12` 的 E 组已经改成
**20 seed 均值判红 + 单点只提示**：看到「⚠ 单点抽样与均值相差 ≥3」就知道该看均值，
而不是去改词表。自己量任何指标也照这个口径：**多个种子取均值，别锁单点**。

### 4. 全绿 ≠ 覆盖

「23 篇全绿」只等于「已覆盖的形态全绿」。新形态稿件一轮就能挖出旧用例没盖住的缺陷。

### 5. 断言纪律

- 判串必须是**独立常量**，不许从生产表反查。
  `new RegExp(FORMAL_FORBIDDEN.join("|"))` 这种写法，删掉表项会连带删掉对它的检查，
  等于给缺陷发通行证。
- 补完测试必须做**变异检验**（故意注入缺陷，确认测试真的变红）。
- 编辑测试文件要**整块字符串替换**，别按行号 splice（行号会漂移）。

## 三、提交前检查清单

`npm run check:release` **不含 tsc 和 eslint**——它绿了不代表可以提：

```bash
npx tsc -b
npm run lint
npm run check:release
```

跑单测要**出工作区**（工作区内跑 vitest 会全文件报 `Cannot read properties of undefined (reading 'config')`）：

```bash
cd /d/projects
env -u NODE_OPTIONS node D:/projects/quaiwei/node_modules/vitest/vitest.mjs run --root D:/projects/quaiwei [文件]
```

全量门禁：`npm run test:cov`

## 四、动文档的两条硬纪律

- **不要**对 `README.md` / `SKILL.md` / `CHANGELOG.md` 跑 `prettier --write`（表格会被整段重排）。
- **两份 `使用说明.txt` 不是同一份文件**：根目录那份是 Web 版（`一、二、三` 编号 + 框线），
  `electron-app/` 那份是桌面版（`════` 框 + `【小标题】`，内容与结构都不同）。
  改文档时按**内容**改，别 `Copy-Item` 按路径同步——2026-10-24 实测把桌面版整篇换血了一次（diff 133 行）。
- `git checkout -- <md>` 会把 LF 转成 CRLF ⇒ `SKILL.md` 的 frontmatter 与多行锚定直接失效
  （`skill-md.test.ts` 红两条）。恢复后必须把行尾转回 `\n`。
- CHANGELOG 章节标题必须含字面「更新」（`## vX.Y.Z 更新`），否则 `check:version` 会跳过该章。

## 五、发版顺序（返工过多次）

1. 改代码 + CHANGELOG
2. **先 git commit（工作区必须干净）**
3. `npm run build`
4. `cd electron-app && npm run repack`
   （可选）`npm run smoke:desktop` —— 验主进程能起来；**必须在有交互桌面的终端里跑**，
   Agent/CI 会话起不了 GUI，判据见 `docs/桌面端冒烟-2026-10-23.md`
5. `npm run check:release`（必须在 repack **之后**）
6. `npm run make:zip`（= `scripts/make-zip.mjs`，产出 `electron-dist/QuAiWei-win32-x64-v<版本>.zip` + `.sha256`；
   打公开包前必须先删 `electron-app/preset-keys.txt` 再 repack）。
7. `node scripts/_publish.cjs`

**打公开包前那条 Key 纪律（2026-10-24 差点翻车）**：删除 `preset-keys.txt` 之前，先把备份写到
仓库内的 `.box-agent-scratch/`（**别写 %TEMP%**——临时目录会被清理，而源文件已经删了），
并且**两份来源的 sha256 必须一致**再删：`electron-app/preset-keys.txt` 与 `scripts/.sensenova-keys`。

`make:zip` 现在会**遍历整棵产物树**拒绝两类东西：任何 `preset-keys.txt`、任何 `*.stale-*` 残留。
原本只查 `resources/app/preset-keys.txt` 一个定点路径，结果 repack 一次清理失败留下的
`resources/app.stale-<ts>`（整份旧 app + 里面那份 Key）把「带 Key 的公开包」送到了上传前一步，
体积也从 203 MiB 涨到 267.5 MiB。

版本号强校验 **9 处**（`npm run check:version`）：根 `package.json` / `electron-app/package.json` /
README 标题行 / README「当前版本」行 / CHANGELOG 本版章节 / 两份 `使用说明.txt` / `一键启动.bat` /
`环境依赖安装.bat`；产物存在时再加一处 `resources/app/package.json`。
**`SKILL.md` 的 `metadata.version` 不在这个脚本里**，由 `skill-md.test.ts` 与 `package.json` 比对守住——
改版本时别只跑 `check:version`，`npm test` 也要过。

> 第 6 步此前写的是 `artifacts/_make-zip.cjs`，而 `artifacts/` 是 gitignore 的——
> 换台机器按本流程走，最后一步必然找不到文件。现已移到 `scripts/make-zip.mjs`（进仓库）。

### 提交钩子（新克隆必看）

`.githooks/pre-commit` 里有四道防线：密钥形态拦截 → 凭证账本 append-only → `tsc` → `eslint` + `prettier`。
git 默认**不会**跑它，必须设 `core.hooksPath`：

```bash
npm install          # prepare 钩子会自动设好（scripts/install-hooks.mjs）
npm run setup:hooks  # 或者手动跑这一条
```

没设的话，上面四道一条都不会执行——2026-10-22 实测过一次：钩子文件在仓库里躺着，
`core.hooksPath` 却是空的。

## 六、话术红线

项目对内对外都 **不得出现「保证通过 XX 检测」「包降 AI 率」这类话术**，
由 `skill-md.test.ts` 与 `check-regex-defects.ts` 双重拦。
aiScore 是**代理分**，不与任何检测器官方分标定——这一点写在 README 的诚实声明里，不要绕开它。
