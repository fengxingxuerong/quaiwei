# MCP 服务端（v0.9.81）

> 类型：当前口径。改了 `src/mcp/server.ts` 就同步改这份。
> 一句话：把本仓的**本地引擎**做成 MCP 工具，让 Claude Code / Codex / Cursor / DSH 里
> 的 agent 直接调用「改后正文」，而不是拿到一段「请你自己改」的提示词。

## 1. 为什么做这条入口

同类的头部项目这周都在往 agent 内部走：`ilyautov/humanizer-ru` 带 MCP + Chrome 扩展，
`humanpen/humanpen-mcp` 用 MCP 直接改 .docx/.pptx。用户写作的位置已经从「打开某个网站」
挪到「编辑器里的 agent」——skill 只给规则，MCP 给的是**可反复调用的确定性函数**。

本仓的引擎恰好适合：纯函数、离线、固定 seed 可复现、不编事实。这三件事 skill 做不到。

## 2. 装

```bash
# 从本仓构建（产物：dist-cli/quaiwei-mcp.mjs）
npm run build:cli
npm run smoke:mcp        # 冒烟：拿打包产物跑一遍真协议
```

Claude Desktop / Claude Code / Cursor 里登记一个 stdio server 即可，命令是 `quaiwei-mcp`
（npm 全局装）或 `node <仓库>/dist-cli/quaiwei-mcp.mjs`。

```jsonc
// 以 Claude Desktop 的 claude_desktop_config.json 为例
{
  "mcpServers": {
    "quaiwei": { "command": "node", "args": ["D:/projects/quaiwei/dist-cli/quaiwei-mcp.mjs"] }
  }
}
```

不需要 Key、不联网。`initialize` 回给客户端的 `instructions` 里已经写明边界，
agent 一接上就知道「本地分不是检测器官方分」。

## 3. 四个工具

| 工具 | 干什么 | 返回 |
|---|---|---|
| `humanize_text` | 去味，只换词/断句/删套话 | 第一块是改后正文（可直接用），有风险时追加一块说明 |
| `detect_ai` | 只读自检，不动原文 | 代理分、档位、风险最高的句子与命中原因 |
| `quality_report` | 去味 + 交稿前自检报告 | 前后分、逐条改动（含「是否推断」）、结构保真、数字保真、可读性小结 |
| `academic_report` | 论文场景硬出口：判 READY / NOT READY | 阻断项（数字/单位、引用键、结构）、提醒项（断言变重、残留套话）、这轮查了什么 |

参数（三者共通的前三项之外的）：

| 参数 | 取值 | 说明 |
|---|---|---|
| `text` | 字符串，必填 | 纯文本，≤20 万字；再大请走 CLI |
| `intensity` | 0~1，默认 0.6 | 0.9 会动更多句式；正式稿别超过 0.6 |
| `style` | `plain`/`casual`/`academic`，默认 `plain` | 论文、公文用 plain 或 academic |
| `seed` | 整数，默认 20260905 | 固定后同一段文本每次产出逐字相同 |
| `zhuque` | 布尔，默认 false | 朱雀增强特征（方言/插入语/句式碎片） |
| `variant` | `zh-TW`，默认不传 | 地区用词校正：软件→软体、信息→资讯，半角标点转全角。不做简繁转换（见 [`regional-zh.md`](regional-zh.md)） |
| `top` | 1~8，默认 5 | 只给 `detect_ai`：列几条高风险句 |
| `rewritten` | 字符串，可选 | 只给 `academic_report`：待检的改写稿。给了就审这一份（引擎不参与改写），不给就由引擎按 academic 跑一遍再审 |

`humanize_text` 的 `structuredContent` 里另有 `scoreBefore` / `scoreAfter` /
`fidelityPass` / `numberWarning`，客户端支持结构化输出时可以直接读，不必解文本。

## 4. 一次真实调用长什么样

```jsonc
// →
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": { "name": "humanize_text", "arguments": { "text": "值得注意的是，本季度共发布了 3 个版本……" } } }

// ←（节选）
{ "jsonrpc": "2.0", "id": 3, "result": {
    "content": [{ "type": "text", "text": "本季度发布了 3 个版本……" }],
    "structuredContent": { "scoreBefore": 32, "scoreAfter": 14, "changed": true, "fidelityPass": true } } }
```

实际跑出来的数字见 `npm run smoke:mcp`：同一段 114 字的套话稿，本地代理分 32 → 14，
`17`/`3` 两个数字原样保留。

## 5. 边界（别在工具描述里夸口，也别在外面替它夸）

- **只做简体中文**。词表是简中的；英文、繁中、日韩不在本引擎的调优范围内。
- **打分是代理指标**。`detect_ai` 与 `humanize_text` 共用一套词表，所以去味后分数必然好看；
  这和「通过了检测」是两件事，README 顶部那段警告对它一字不减。
- **不承诺通过任何检测器**，`initialize` 的 `instructions` 里明写。
- **不做 LLM 调用**。MCP 这条路只接本地引擎；要用 LLM 深度模式走 CLI 的 `--api`。
- 超长文本不静默截断：直接 `isError`，并告诉调用方改用 CLI。

## 6. 怎么验

| 命令 | 验的是什么 |
|---|---|
| `npx vitest run src/mcp/server.test.ts` | 协议契约与工具语义（20 例，含坏 JSON 不崩、通知不回包、seed 可复现、超长报错、variant 透传、学术判定） |
| `npm run smoke:mcp` | **打包产物**本身：shebang、esbuild 打进来还能不能跑、stdout 有没有被别的东西污染 |
| `npx tsc -b` / `npx eslint src/mcp` | 类型与 lint |

改 `scripts/build-cli.mjs` 的入口列表后必须先跑 `smoke:mcp`——单元测试走的是源码 import，
打不出 bundle 的问题它看不见。

## 7. 已知没做的

- 没有 `outputSchema`：`structuredContent` 给了但客户端不会做 schema 校验（多数客户端也不做）。
- 没有批量工具：一次一篇。批量走 CLI（`ai-humanizer <目录> --out <目录>`）。
- 没有 `--api` 通道：MCP 里不读环境变量里的 Key，避免"在编辑器里默默花钱"。
- 没接流式：单次调用要等整篇跑完（本地引擎，万字数级是秒内的事）。
- **还没发布到 npm**：`ai-humanizer` / `quaiwei` / `@fengxingxuerong/quaiwei` 三个名字
  在 registry 上都还是 404（2026-10-26 查）。本机没有 npm 凭证，这一步要本人跑。

## 8. 发布（一条命令，需要 npm 登录）

包名先到先得，`ai-humanizer` 是这行搜索量最高的词，别被别人占了：

```bash
npm login                     # 一次性
npm whoami                    # 确认登录的是自己
npm publish --dry-run         # 看清单：应有 dist-cli/ 两个产物、SKILL.md、README
npm publish                   # 真发
```

发完验一遍（不要只看 npm 页面）：

```bash
npx -y ai-humanizer@latest --help          # CLI 通道
npx -y quaiwei-mcp                         # MCP 通道：应立刻进入 stdio 等待，而不是报错
```

`quaiwei` 那个名字要不要一起占：npm 一个包只能一个名。要占就再发一个瘦包
（`dependencies: { "ai-humanizer": "^0.9" }`，bin 转发），别复制代码。

## 9. 发布后要改的文档

- 本文第 2 节的安装方式（`npx ai-humanizer mcp` 会比 `node <仓库>/dist-cli/...` 顺手）；
- README 的「作为 MCP 工具接进 agent」一节补一行 `npx`；
- SKILL.md 的 MCP 段落同理。
