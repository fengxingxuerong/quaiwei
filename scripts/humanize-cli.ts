/**
 * scripts/humanize-cli.ts —— 批量去味 CLI（v0.8.6 起；v0.9.15 补 LLM 通道）
 *
 * 竞品（嘎嘎降AI/零感AI/千笔AI）标配「批量上传多文件处理」，本项目此前只有 UI 单篇模式。
 * 本 CLI 补齐：批量处理 .txt 文件，输出到指定目录。
 *
 * v0.9.15 之前只接了本地引擎（`src/engine/humanize`），`src/api` 那 28 个模块
 * （深度闭环 / 交叉评判 / 定向修订 / 长文分块）CLI 完全够不到 —— 等于「批量」这个卖点
 * 只兑现了一半。现在 `--api` 走 UI 同款的 `runHumanize`，本地回退逻辑一并继承。
 *
 * v0.9.17：输入侧接上 .docx（v0.9.16 只做了 UI，CLI 仍是「.txt only」，CHANGELOG 里
 * 明写着「CLI 的 .docx 输入暂未接」）。现在 `.docx` 与 `.txt`/`.md` 一并批量处理，
 * 输出格式默认**跟随输入**（.docx 进 → .docx 出），`--out-format txt|docx` 可强制覆盖。
 *
 * 用法：
 *   npx tsx scripts/humanize-cli.ts <input-dir-or-file> [--out <dir>] [--intensity 0.6]
 *       [--zhuque] [--style casual|plain|academic] [--suffix .humanized] [--seed 20260905]
 *       [--api [--base-url <url>] [--model <name>] [--api-key <key>] [--judge-model <name>]]
 *       [--alt-model <name>] [--no-deep] [--contest <n>] [--max-calls <n>] [--max-wait <sec>]
 *       [--target <1-100>] [--strict] [--persona default|netgen|classic] [--report <file.json>]
 *       [--out-format follow|txt|docx] [--explain] [--detect-only]
 *       [--detector-url <url> [--detector-key <key>] [--detector-path <json.path>]...  // 可重复，多档对比
 *        [--detector-scale 0-100|0-1]]
 *       [--recursive] [--jobs <n>] [--dry-run]
 *
 * 示例：
 *   npx tsx scripts/humanize-cli.ts ./docs-txt --out ./out --intensity 0.9 --zhuque
 *   npx tsx scripts/humanize-cli.ts ./docs-txt --explain   # 每篇改完附「为什么这么改」清单
 *   npx tsx scripts/humanize-cli.ts ./word-docs --out ./out          # .docx 进 .docx 出
 *   npx tsx scripts/humanize-cli.ts ./word-docs --out-format txt     # 强制落成 .txt
 *   npx tsx scripts/humanize-cli.ts ./稿箱 --recursive --dry-run      # 递归预览，不落盘
 *   # LLM 深度模式（Key 走环境变量，别写进命令行历史）：
 *   QUAIWEI_API_KEY=sk-xxx npx tsx scripts/humanize-cli.ts ./in --api --model deepseek-v4-flash
 *
 * 支持输入：.txt / .md（按 UTF-8 文本读；v0.9.32 起自动识别 UTF-8 BOM / UTF-16 / GBK 并转码）
 * 与 .docx（零依赖 OOXML 解析，只取段落纯文本）。
 *
 * v0.9.32（全方位优化轮，依据 cli-fulltest 26+11 场景实战测试的发现）：
 *   1) 编码检测：Windows 记事本老文件常见 GBK/UTF-16，此前按 UTF-8 硬读直接变乱码稿
 *      （去味引擎再怎么改也是乱码——最坏的是用户看不出来）。现在 BOM 优先，
 *      无 BOM 先严格 UTF-8、失败落 GBK，并在控制台明说转码了哪个文件；产物一律 UTF-8。
 *   2) 回环防护：out=输入目录时，二轮会把上一轮产物 *.humanized.txt 再吃一遍，
 *      产出 *.humanized.humanized.txt 且层层叠加。现在目录批量默认跳过带输出后缀的文件
 *      （单文件显式指名不受限），重跑幂等。
 *   3) --recursive：目录默认仍不递归（旧行为），给了开关才走进子目录（隐藏目录一律跳过）。
 *   4) --jobs：--api 模式按 N 路并发处理文件（网络等待型，加速明显）；本地引擎单线程，
 *      给了也只提示不生效。
 *   5) --dry-run：只列出将处理哪些文件（含跳过原因），不建目录不落盘，随时可跑。
 *   6) 输出增强：批量行加 [k/n] 进度前缀；收尾加耗时/字数/AI 味代理分均值汇总；
 *      report 增加 outPath 与 totals 段。输入路径不存在时给一句话错误而非 ENOENT 堆栈。
 *
 * Key 来源优先级（CLI 专用，与 UI 设置面板无关）：
 *   1) --api-key
 *   2) 环境变量 QUAIWEI_API_KEY
 *   3) 环境变量 OPENAI_API_KEY
 *   4) loadPresetKeys()：SENSENOVA_KEYS 环境变量 / scripts/.sensenova-keys（gitignore）
 */
import fs from "fs";
import path from "path";
import { humanize, adviceFor } from "../src/engine/humanize";
import { aiScore } from "../src/engine/humanize-metrics.ts";
import { registerIndex, type RegisterReport } from "../src/engine/register-metrics.ts";
import { isLowYieldRisk, LOW_YIELD_FORMAL_PER_1K } from "../src/engine/low-yield.ts";
import { detectAI } from "../src/engine/detector";
import { explainChanges, formatExplain, type ExplainItem } from "../src/engine/explain";
import { formatReview, reviewText, type ReviewReport } from "../src/engine/review";
import { runHumanize } from "../src/api/llm";
import { DEFAULT_API, loadPresetKeys, type ApiConfig } from "../src/api/llm-config";
import { scoreViaDetector, inferZhuqueDefaults, type DetectorConfig } from "../src/api/detector";
import { readDocxText, writeDocxText } from "../src/docx-io";
import { applyRegionalVariant, formatRegionalSummary, type RegionalHit } from "../src/engine/regional-zh";
import { academicAudit, formatAcademicReport } from "../src/engine/academic-check";
import { auditStructure, formatStructureReport } from "../src/engine/structure-audit";
import {
  structureMetrics,
  formatMetrics,
  compareMetrics,
  type StructureMetrics,
  type MetricDelta,
} from "../src/engine/structure-metrics";

/** Buffer → 独立 ArrayBuffer（Buffer 可能是共享内存池上的视图，直接给 .buffer 会串） */
function toArrayBuffer(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/**
 * 输入文件 → 纯文本。.docx 解析失败时把真实部件名抛给上层（与 UI 一致，不吞根因）。
 *
 * v0.9.32：txt/md 的编码检测。此前一律按 UTF-8 硬读，GBK 老文件会变成整篇乱码
 * 且**看不出来**（乱码照样能"去味"，产出一份谁也用不了的稿子）。
 * 顺序：BOM（UTF-8/UTF-16LE/UTF-16BE）→ 严格 UTF-8 → GBK → lenient UTF-8 兜底。
 * 产物侧无条件落 UTF-8（writeOutput 的 encoding 参数固定 "utf-8"）。
 */
async function readInputText(f: string): Promise<string> {
  if (!f.toLowerCase().endsWith(".docx")) return decodeTextBuffer(fs.readFileSync(f), f);
  return readDocxText(toArrayBuffer(fs.readFileSync(f)));
}

/** BOM / GBK 检测 + 转码（纯函数语义，便于单独推理；console.warn 说明转码了谁） */
function decodeTextBuffer(buf: Buffer, f: string): string {
  const name = path.basename(f);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(buf.subarray(3)); // UTF-8 BOM：剥掉再读
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    console.warn(`⚠ ${name}：UTF-16LE 编码，已转码为 UTF-8 读取`);
    return new TextDecoder("utf-16le").decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    console.warn(`⚠ ${name}：UTF-16BE 编码，已转码为 UTF-8 读取`);
    return new TextDecoder("utf-16be").decode(buf.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    /* 非法 UTF-8 字节序列 → 落 GBK 试一次 */
  }
  try {
    const gbk = new TextDecoder("gbk").decode(buf);
    console.warn(`⚠ ${name}：不是合法 UTF-8，已按 GBK 转码读取（产物统一落 UTF-8）`);
    return gbk;
  } catch {
    return new TextDecoder("utf-8").decode(buf); // lenient 兜底：宁可有稿也不吞文件
  }
}

/**
 * 输出扩展名：`--out-format` 显式给了就听它的，否则跟随输入
 * （.docx 进 → .docx 出；用户拿 Word 稿来批量处理，落回 .txt 反而多一道手）。
 */
function outExtOf(inputFile: string, outFormat: string): string {
  if (outFormat === "docx") return ".docx";
  if (outFormat === "txt") return ".txt";
  return inputFile.toLowerCase().endsWith(".docx") ? ".docx" : ".txt";
}

async function writeOutput(dest: string, text: string, asDocx: boolean): Promise<void> {
  if (!asDocx) {
    fs.writeFileSync(dest, text, "utf-8");
    return;
  }
  const blob = await writeDocxText(text);
  fs.writeFileSync(dest, Buffer.from(await blob.arrayBuffer()));
}

interface Args {
  input: string;
  out: string;
  intensity: number;
  zhuque: boolean;
  style: "casual" | "plain" | "academic";
  suffix: string;
  /** v0.9.15：本地引擎种子。此前硬编码 20260905 且不可改，批量结果无法与 UI 对齐复现。 */
  seed: number;
  /* ---- LLM 通道（--api 生效） ---- */
  api: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  judgeModel: string;
  altModel: string;
  deep: boolean;
  contest: number;
  maxCalls: number;
  maxWait: number;
  /** 单次 LLM 请求超时（秒）。0 = 沿用默认 90 秒 */
  llmTimeout: number;
  /** v0.9.62 深度模式达标线：LLM 评判 ≤ 此分即收手。0 = 沿用默认（DEEP_TARGET_SCORE） */
  target: number;
  strict: boolean;
  /** v0.9.82：受限句序重排（默认关）。产出是原句排列，"不新增事实"构造上成立 */
  structural: boolean;
  /** 显式跳过低收益风险稿（默认关，照常改写）。判据见 src/engine/low-yield.ts；默认关=opt-in */
  skipLowRisk: boolean;
  persona: string;
  report: string;
  /** v0.9.17：输出格式。follow = 跟随输入扩展名（.docx 进 → .docx 出） */
  outFormat: "follow" | "txt" | "docx";
  /** v0.9.30：改完附「为什么这么改」清单（句级 diff 反查规则表，事后归因） */
  explain: boolean;
  /** v0.9.32：目录扫描递归子目录（默认关，与旧行为一致；隐藏目录一律跳过） */
  recursive: boolean;
  /** v0.9.32：--api 模式并发路数（本地引擎单线程，>1 只提示不生效） */
  jobs: number;
  /** v0.9.32：只列出将处理的文件，不建目录不落盘 */
  dryRun: boolean;
  /** v0.9.38：stdin 管道模式。输入参数给 `-` 或整个省略时置位；正文走 stdout、诊断走 stderr */
  stdin: boolean;
  /** v0.9.40：--help / -h。打印用法后正常退出（0），不再落进「未知参数」的错误分支 */
  help: boolean;
  /**
   * v0.9.52：审题模式。只输出「AI 味痕迹地图」（哪些句、为什么、怎么改），
   * **一个字都不改、一个文件都不落盘**。与 `--dry-run` 的区别：后者列的是待处理文件清单，
   * 这里列的是本文的问题清单。
   */
  detectOnly: boolean;
  /**
   * v0.9.81：地区用词校正。`none` = 不动（默认，行为与之前逐字相同）；
   * `zh-TW` = 台湾用词 + 半角标点转全角。**不做简繁转换**——字形是 OpenCC 的活，
   * 本仓手写表只会拼出混合字形，所以这里明确只换词与标点。
   */
  variant: "none" | "zh-TW";
  /**
   * v0.9.81：学术自检（`--academic-check`）。**不落盘**，只打一份带判定的报告：
   * 数字/单位、引用键、结构、断言词、残留套话，有阻断项退出码 2（NOT READY）。
   */
  academicCheck: boolean;
  /**
   * v0.9.84：篇章结构审计（`--audit-structure`）。**不落盘、不改一个字**，
   * 只报「骨架像不像 AI」：标题承诺兑现、论点前置、首尾复述、小标题密度、
   * 无人称解说腔、编号步骤化、段落均匀度。有 high 项退出码 2。
   */
  auditStructure: boolean;
  /** v0.9.85：结构指标（`--metrics`）。**不落盘、不改一个字**，只输出句法统计。 */
  metrics: boolean;
  /**
   * v0.9.81：`--against <文件>`。给学术自检用：拿这份**外部改写稿**去比原文，
   * 引擎不参与改写（审的是 LLM 深度模式产出 / 外部改写 / 合作者改的版本）。
   */
  against: string;
  /** v0.9.81：`--style` 是否被显式给过。学术自检默认按 academic 跑，用户显式指定就不覆盖 */
  styleExplicit: boolean;
  /* ---- v0.9.66：外部检测器（任意 OpenAI 无关的 HTTP 接口，不绑定任何厂商） ---- */
  /**
   * v0.9.71：**可重复**的检测器档位。`--detector-url` 每出现一次就开一个新档，
   * 紧随其后的 --detector-key/--detector-path/--detector-scale 作用在**最近一档**上。
   * 一档时的行为与 v0.9.66 完全一致；多档时同一篇稿子会分别送检，做跨厂商横向对比。
   */
  detectors: {
    url: string;
    key: string;
    path: string;
    scale: "0-100" | "0-1";
  }[];
  /** 检测器 URL；给了就启用（把 {text} POST 过去，按 --detector-path 取分） */
  detectorUrl: string;
  /** 检测器凭证（也可用环境变量 QUAIWEI_DETECTOR_KEY，避免写进 shell 历史） */
  detectorKey: string;
  /** 响应里分数的 JSON 点路径，默认 score */
  detectorPath: string;
  /** 分数刻度，默认 0-100（朱雀那类是 0-1） */
  detectorScale: "0-100" | "0-1";
}

const USAGE =
  "用法: ai-humanizer <input-dir-or-file> [--out <dir>] [--intensity 0.6]" +
  " [--zhuque] [--style casual|plain|academic] [--suffix .humanized] [--seed 20260905]" +
  " [--api [--base-url <url>] [--model <name>] [--api-key <key>] [--judge-model <name>]]" +
  " [--alt-model <name>] [--no-deep] [--contest <n>] [--max-calls <n>] [--max-wait <sec>]" +
  " [--llm-timeout <sec>]" +
  " [--target <1-100>] [--strict] [--persona default|netgen|classic] [--report <file.json>]" +
  " [--out-format follow|txt|docx] [--explain] [--detect-only] [--variant none|zh-TW]" +
  " [--academic-check [--against <改后稿>]]" +
  " [--audit-structure [--against <改后稿>]]" +
  " [--metrics [--against <对比稿>]]" +
  " [--detector-url <url> [--detector-key <key>] [--detector-path <json.path>] [--detector-scale 0-100|0-1]]..." +
  " [--recursive] [--jobs <n>] [--dry-run] [--skip-low-risk]\n" +
  "  输入参数给 - 或整个省略时走标准输入：cat 稿.txt | ai-humanizer --intensity 0.8（正文 stdout，诊断 stderr）\n" +
  "  --base-url 填网关绝对地址（如 https://token.sensenova.cn/v1）。UI 设置里的 /sensenova/v1" +
  " 是同源代理专用写法（代理会剥掉 /sensenova 前缀再转发），CLI 直连勿带这段前缀。\n" +
  "  --llm-timeout <sec>：单次 LLM 请求超时，默认 90 秒（上限 600）。思考型模型 + 长提示词" +
  " 在慢网关上可能要 2~3 分钟，调大它可避免请求被掐断后误报「模型返回空内容」。\n" +
  "  --detector-url：接**任意**外部检测器（把 {text} POST 过去，按 --detector-path 取分，" +
  "默认 0-100 刻度）。原文与产出各送一次，前后分与降幅写进 --report 的 detector 段；" +
  "**可重复**——给多个 --detector-url 就逐档送检、横向对比（紧跟其后的 key/path/scale 只作用在这一档）。" +
  " 凭证建议走环境变量 QUAIWEI_DETECTOR_KEY，别写进命令行历史。\n" +
  "  --detector-url 指向朱雀官方网关（.../v1/providers/zhuque-text/classify）时自动补 " +
  "softmax_confidence + 0-1 刻度，不必手填；显式给 path/scale 则以你给的为准。\n" +
  "  --recursive 目录扫描进子目录（默认不进）；--jobs 仅 --api 模式生效（并发路数）；" +
  "  --dry-run 只列出将处理的文件不落盘。目录批量默认跳过已带输出后缀的产物（重跑幂等）。" +
  "\n  --detect-only 审题模式：只给「AI 味痕迹地图」（哪句、为什么命中、怎么改），" +
  "一个字都不改也不落盘，无需 API Key。与 --dry-run（列待处理文件清单）不是一回事。" +
  "\n  --help / -h 打印本用法（退出码 0）。" +
  "\n  --variant zh-TW：台湾用词 + 半角标点转全角（默认 none 不动）。" +
  "\n  --structural 受限句序重排（默认关）：强度 ≥0.55 且论说/公文/学术体裁时，" +
  "对守卫全过的相邻句做至多一次交换——产出是原句排列，句多重集逐字不变，" +
  "\"不新增事实\"构造上成立；叙事/人写体裁不受影响（保留作者结构）。" +
  "开启即尝试（不再随机跳过），守卫全过才换；--report 的 structuralApplied 可查本轮是否真的换了。" +
  "**不做简繁转换**——字形请自己过 OpenCC，这里只换词与标点，输入简体、输出简体。" +
  "词表只收无歧义的词（`程序`/`质量`/`文件` 这类一词两义的不换）。" +
  "\n  --academic-check：学术自检。**不落盘**，只打一份带判定的报告（数字/单位、引用键、" +
  "结构、断言词、残留套话）。退出码 0 = READY，2 = NOT READY（有阻断项），1 = 没法跑。" +
  "默认按 academic 文风跑，显式给 --style 则以你给的为准。" +
  "\n  --skip-low-risk 低收益风险稿**原样出稿、不改写**（默认关，照常改写）。" +
  `判据 = 书面标记密度 formalPer1k≤${LOW_YIELD_FORMAL_PER_1K}/千字（长度归一，不看 aiScore）：` +
  "书面套话稀薄时删套话规则没有作用对象，改写主要只能动断句和用词。" +
  "44 篇误伤基准台归因：旧判据 aiScore≤27 && formalHits≤2 在真人长文上 0 命中" +
  "（formalHits 是长度函数，字数相关系数 0.958）；新判据命中 15/21，" +
  "开启后模拟残余误伤率 57%→14%，该改面板达改率不变。" +
  "代价：23 篇该改稿里仍误跳 10 篇，双网关配对显示这些稿改写多半更像人 ⇒ 开关继续默认关。" +
  "交叉复核 evidence/collateral-cross-2026-11-09/：15 篇短真人稿密度中位 4.6（长真人 6.4）、" +
  "同长度区间 AUC 0.683、长度分层 5.1~6.1 稳定 ⇒ 判据不随长度漂移；但体裁混淆未分离、长 AI 稿未实测，阈值仍属探索性。" +
  "--report 记 lowYieldRisk / skippedLowRisk；引擎层（Web/MCP/API）行为不变。" +
  "\n  --against <文件>：配合 --academic-check 用。拿这份**外部改写稿**去比原文，" +
  "引擎不参与改写——审的是 LLM 深度模式产出、别人改的版本。这条路最容易真的丢数字/丢引用，" +
  "也是唯一能判出 NOT READY 的实战场。" +
  "\n  --audit-structure：篇章结构审计。**不落盘、不改一个字**，只报骨架问题：" +
  "标题承诺没兑现（说三个方法只写了一个）、论点后置（结论落在 60% 之后）、首尾复述、" +
  "小标题过密、无人称解说腔、编号步骤化、段落长度过于均匀。判据全是可数特征，" +
  "同一份稿子跑一百次报告逐字相同；不调模型、不联网。有 high 项退出码 2，否则 0。" +
  "配 --against 则把外部改写稿也审一遍（对比用），不参与改写。" +
  "**只报告，不自动改结构**——动段落顺序会破「不新增事实」的构造性保证，那一步留给人。" +
  "\n  --style academic 时「无人称解说腔」降为 low（学术写作里「我们」本就合法），其余判据一视同仁。";

function parseArgs(argv: string[]): Args {
  const args: Args = {
    input: "",
    out: "",
    intensity: 0.6,
    zhuque: false,
    style: "plain",
    variant: "none",
    academicCheck: false,
    auditStructure: false,
    metrics: false,
    against: "",
    styleExplicit: false,
    suffix: ".humanized",
    seed: 20260905,
    api: false,
    baseUrl: "",
    model: "",
    apiKey: "",
    judgeModel: "",
    altModel: "",
    deep: true,
    contest: 1,
    maxCalls: 0,
    maxWait: 0,
    llmTimeout: 0,
    target: 0,
    strict: false,
    structural: false,
    skipLowRisk: false,
    persona: "default",
    report: "",
    outFormat: "follow",
    explain: false,
    recursive: false,
    jobs: 1,
    dryRun: false,
    stdin: false,
    help: false,
    detectOnly: false,
    detectors: [],
    detectorUrl: "",
    detectorKey: "",
    detectorPath: "score",
    detectorScale: "0-100",
  };
  const a = argv.slice(2);
  // v0.9.40：--help / -h 在最前面拦截。此前它落进 default 分支 →「未知参数」+ 退出码 1，
  // 而 --help 恰是命令行工具的第一个动作（也是 npm 分发后别人的第一印象）。
  // 这里只置位不做输出：parseArgs 是纯函数（scripts-logic.test.ts 的 vm 沙箱里没有
  // process 的 argv/stdin 可依赖），打印统一交给 main。
  if (a.includes("--help") || a.includes("-h")) {
    args.help = true;
    return args;
  }
  // v0.9.38：stdin 管道模式。输入参数给 `-`（Unix 惯例）或**没有任何位置参数**时置位
  // stdin，正文从 fd 0 读、结果写 stdout、诊断走 stderr（`ai-humanizer - < 稿.txt > 去味.txt`）。
  // 位置参数要「剥掉选项」才能定位：选项可以占首位（`--seed 42` 无路径也是合法管道用法），
  // 所以第一遍扫出输入 token 的下标，第二遍再解析选项（跳过该下标）。
  // 省略参数时**不能在这里判 TTY**——parseArgs 是纯函数（scripts-logic.test.ts 的 vm 沙箱里
  // 没有 process.stdin），交互终端下的「用法+退出」交给 main 补判。
  const VALUED_OPTS = new Set([
    "--out",
    "--intensity",
    "--style",
    "--variant",
    "--against",
    "--suffix",
    "--seed",
    "--base-url",
    "--model",
    "--api-key",
    "--judge-model",
    "--alt-model",
    "--contest",
    "--max-calls",
    "--max-wait",
    "--llm-timeout",
    "--persona",
    "--report",
    "--out-format",
    "--jobs",
  ]);
  let inputIdx = -1;
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t === "-") {
      inputIdx = i; // 显式 stdin
      break;
    }
    if (t.startsWith("-") && t !== "") {
      if (t.startsWith("--") && VALUED_OPTS.has(t)) i++; // 带值选项：连它的值一起跳过
      continue;
    }
    inputIdx = i; // 第一个位置参数（空串也落这里，下面按原行为打法）
    break;
  }
  if (inputIdx === -1 || a[inputIdx] === "-") {
    args.input = "-";
    args.stdin = true;
  } else if (a[inputIdx] === "") {
    console.error(USAGE);
    process.exit(1);
  } else {
    args.input = a[inputIdx];
  }
  const num = (v: string | undefined, d: number) => {
    const n = parseFloat(v ?? "");
    return Number.isFinite(n) ? n : d;
  };
  for (let i = 0; i < a.length; i++) {
    if (i === inputIdx) continue; // 输入路径已在上面定走，不当选项解析
    switch (a[i]) {
      case "--out":
        args.out = a[++i] ?? "";
        break;
      case "--intensity":
        args.intensity = Math.max(0, Math.min(1, num(a[++i], 0.6)));
        break;
      case "--zhuque":
        args.zhuque = true;
        break;
      case "--style":
        args.style = (a[++i] as Args["style"]) || "plain";
        args.styleExplicit = true;
        break;
      case "--academic-check":
        args.academicCheck = true;
        break;
      case "--audit-structure":
        args.auditStructure = true;
        break;
      case "--metrics":
        args.metrics = true;
        break;
      case "--against":
        args.against = a[++i] ?? "";
        break;
      case "--variant": {
        const v = (a[++i] ?? "").trim();
        if (v !== "none" && v !== "zh-TW") {
          console.error(`--variant 只认 none 或 zh-TW，收到：${v}\n${USAGE}`);
          process.exit(1);
        }
        args.variant = v;
        break;
      }
      case "--suffix":
        args.suffix = a[++i] ?? ".humanized";
        break;
      case "--seed":
        args.seed = Math.floor(num(a[++i], 20260905));
        break;
      case "--api":
        args.api = true;
        break;
      case "--base-url":
        args.baseUrl = a[++i] ?? "";
        break;
      case "--model":
        args.model = a[++i] ?? "";
        break;
      case "--api-key":
        args.apiKey = a[++i] ?? "";
        break;
      case "--judge-model":
        args.judgeModel = a[++i] ?? "";
        break;
      case "--alt-model":
        args.altModel = a[++i] ?? "";
        break;
      case "--no-deep":
        args.deep = false;
        break;
      case "--contest":
        args.contest = Math.max(1, Math.floor(num(a[++i], 1)));
        break;
      case "--max-calls":
        args.maxCalls = Math.max(0, Math.floor(num(a[++i], 0)));
        break;
      case "--max-wait":
        args.maxWait = Math.max(0, Math.floor(num(a[++i], 0)));
        break;
      case "--llm-timeout":
        // 0 = 不覆盖（沿用 90 秒）；上限由 resolveRequestTimeoutMs 统一钳到 600 秒
        args.llmTimeout = Math.max(0, Math.floor(num(a[++i], 0)));
        break;
      case "--target":
        // 1~100：0 与负数留给"不设、走默认"，>100 等于永不达标之外的反效果
        args.target = Math.max(0, Math.min(100, Math.floor(num(a[++i], 0))));
        break;
      case "--strict":
        args.strict = true;
        break;
      case "--structural":
        args.structural = true;
        break;
      case "--skip-low-risk":
        args.skipLowRisk = true;
        break;
      case "--persona":
        args.persona = a[++i] || "default";
        break;
      case "--report":
        args.report = a[++i] ?? "";
        break;
      case "--out-format": {
        const v = (a[++i] ?? "").toLowerCase();
        if (v === "follow" || v === "txt" || v === "docx") args.outFormat = v;
        else {
          console.error(`--out-format 只接受 follow | txt | docx，收到 "${v}"\n${USAGE}`);
          process.exit(1);
        }
        break;
      }
      case "--explain":
        args.explain = true;
        break;
      case "--recursive":
        args.recursive = true;
        break;
      case "--jobs":
        args.jobs = Math.max(1, Math.floor(num(a[++i], 1)));
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--detect-only":
        args.detectOnly = true;
        break;
      /* ---- v0.9.66 外部检测器（v0.9.71：--detector-url 可重复，多档横向对比） ---- */
      case "--detector-url": {
        const url = a[++i] ?? "";
        args.detectorUrl = url; // 兼容单档：仍保留顶层字段（= 第一档）
        args.detectors.push({ url, key: "", path: "score", scale: "0-100" });
        break;
      }
      case "--detector-key": {
        const key = a[++i] ?? "";
        args.detectorKey = key;
        // 作用在**最近一档**上；还没有任何档就先记到顶层（后面的 --detector-url 会带上它）
        const last = args.detectors[args.detectors.length - 1];
        if (last) last.key = key;
        break;
      }
      case "--detector-path": {
        const p = a[++i] || "score";
        args.detectorPath = p;
        const last = args.detectors[args.detectors.length - 1];
        if (last) last.path = p;
        break;
      }
      case "--detector-scale": {
        const s = (a[++i] ?? "").trim();
        if (s !== "0-100" && s !== "0-1") {
          console.error(`--detector-scale 只认 0-100 或 0-1，收到：${s}\n${USAGE}`);
          process.exit(2);
        }
        args.detectorScale = s;
        const last = args.detectors[args.detectors.length - 1];
        if (last) last.scale = s;
        break;
      }
      default:
        console.error(`未知参数: ${a[i]}\n${USAGE}`);
        process.exit(1);
    }
  }
  if (!args.out) {
    // 单文件时默认输出到它所在目录；目录时输出到它自身（沿用既有行为，只把判定从 .txt 放宽）。
    // stdin 模式的 out 无意义（单篇不落盘），main 会提前返回，这里给个占位即可。
    args.out = isSupportedInput(args.input) ? path.dirname(args.input) : args.input;
  }
  return args;
}

/** 组装 ApiConfig：只覆盖用户显式给过的字段，其余沿用 DEFAULT_API */
function buildApiConfig(args: Args): ApiConfig {
  const keys =
    args.apiKey ||
    process.env.QUAIWEI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    loadPresetKeys().join("\n");
  const cfg: ApiConfig = {
    ...DEFAULT_API,
    enabled: true,
    deepMode: args.deep,
    apiKey: keys,
    apiKeys: keys, // Key 池：429/401 自动切下一个（与 apiKey 合并去重）
    strictFidelity: args.strict,
    contestSamples: args.contest,
    maxApiCalls: args.maxCalls,
    maxWaitSeconds: args.maxWait,
    style: args.style,
  };
  // 达标线：只覆盖用户显式给过的（0 = 沿用 DEEP_TARGET_SCORE），保持"不传即旧行为"
  if (args.target > 0) cfg.deepTargetScore = args.target;
  if (args.baseUrl) cfg.baseUrl = args.baseUrl;
  if (args.llmTimeout > 0) cfg.requestTimeoutMs = args.llmTimeout * 1000;
  if (args.model) cfg.model = args.model;
  if (args.judgeModel) cfg.judgeModel = args.judgeModel;
  if (args.altModel) cfg.altModel = args.altModel;
  if (args.persona === "default" || args.persona === "netgen" || args.persona === "classic") {
    cfg.persona = args.persona;
  }
  return cfg;
}

/**
 * CLI 认的输入扩展名（.docx 自 v0.9.17；去味引擎只吃纯文本，富文本格式一律不保留）。
 *
 * 定义位置有讲究：`scripts/scripts-logic.test.ts` 会按字面量找起止点，把「USAGE 常量 →
 * 主函数」之间的源码切进 vm 沙箱跑纯函数测试，所以这里要用到的常量不能写在文件顶部
 * 那段（不进切片）。同理，本文件的注释里也别写出那两个定位用的字面量——否则切片
 * 会从注释中间开始或结束，esbuild 转译直接失败（v0.9.17 接线时踩到，现象是
 * `Expected 星斜杠 to terminate multi-line comment`）。
 *
 * 自指陷阱备忘：上一行报错原文里含「星号+斜杠」的块注释终止符，原样写进本注释
 * 会把这段 JSDoc 提前掐断——这正是 v0.9.17 接线卡住的根因（esbuild 报
 * Unterminated string literal），所以只能转述为「星斜杠」，后人别手痒改回原样。
 */
const INPUT_EXTS = [".txt", ".md", ".docx"] as const;
const INPUT_EXTS_LABEL = ".txt / .md / .docx";

function isSupportedInput(f: string): boolean {
  const lower = f.toLowerCase();
  return INPUT_EXTS.some((e) => lower.endsWith(e));
}

/**
 * 收集待处理文件：.txt / .md / .docx。
 * （v0.9.17 前只认 .txt，名字也叫 collectTxtFiles——改名是因为它现在不止收 txt。）
 *
 * v0.9.32 返回 { files, skipped }：skipped 统计「已带输出后缀、按回环防护规则跳过」的个数，
 * 供 main 打印。回环防护只作用于**目录扫描**——单文件是用户显式指名的，照单全收。
 */
function collectInputFiles(
  input: string,
  opts: { recursive?: boolean; skipSuffix?: string } = {},
): { files: string[]; skipped: number } {
  const st = fs.statSync(input);
  if (st.isFile()) return { files: isSupportedInput(input) ? [input] : [], skipped: 0 };
  const files: string[] = [];
  let skipped = 0;
  const skip = (opts.skipSuffix ?? "").trim().toLowerCase();
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(".")) continue; // 隐藏项一律不进批量（.git/.covtmp 这类）
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) {
        if (opts.recursive) walk(p);
        continue;
      }
      if (!isSupportedInput(f)) continue;
      // 回环防护：*.humanized.txt 这类上一轮产物不再吃回去（--suffix 可自定义判定词）
      if (skip && INPUT_EXTS.some((e) => f.toLowerCase().endsWith(skip + e))) {
        skipped++;
        continue;
      }
      files.push(p);
    }
  };
  walk(input);
  return { files: files.sort(), skipped };
}

/**
 * CLI 直连误带同源代理前缀检测：UI/桌面版设置里的「/sensenova/v1」由 vite/Electron 代理
 * 剥掉 /sensenova 前缀后转发（rewrite: ^/sensenova → ""）。CLI 直连没有这层代理，
 * 带前缀的地址原样发出去会撞网关 404（{"code":5,"message":"NOT_FOUND"}，报错完全看不出
 * 是路径多了一段——v0.9.17 功能验收实测踩到）。
 *
 * 只判定绝对地址（http(s):// 开头）；相对路径由 main 里另一条「同源相对路径」拦截负责。
 * host 里的 sensenova 域名不受影响：token.sensenova.cn 中该词的前缀是点不是斜杠。
 * 用正则剥 host 而非 new URL——vm 沙箱（scripts-logic.test.ts 切片）没有注入 URL 全局。
 */
function baseUrlHasProxyPrefix(baseUrl: string): boolean {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i.exec(baseUrl.trim());
  if (!m) return false;
  return /^\/sensenova(\/|$)/.test(m[1] ?? "");
}

/** v0.9.82：report 里的语体摘要只留 {index,label}，密度明细不进报告（要细节走 --explain 的思路，别把 JSON 撑肥） */
function briefRegister(r: RegisterReport): { index: number; label: string } {
  return { index: r.index, label: r.label };
}

interface FileReport {
  file: string;
  ms: number;  charsIn: number;
  charsOut: number;
  detectBefore: number;
  detectAfter: number;
  ok: boolean;
  error?: string;
  /** v0.9.32：产物落盘路径（并发/嵌套目录场景里 basename 不足以定位） */
  outPath?: string;
  /** 低收益风险（书面标记密度 formalPer1k≤8/千字，长度归一），与开关是否开启无关 */
  lowYieldRisk?: boolean;
  /** v0.9.84：仅 --skip-low-risk 生效时置位：低收益稿原样出稿（未改写） */
  skippedLowRisk?: boolean;
  /** v0.9.85：仅 --structural 时有意义——本轮是否真的发生了相邻句交换。
   *  守卫全过才为 true；没有可换对、或走 --api 深度模式（不接结构层）时为 false。 */
  structuralApplied?: boolean;
  /* 以下仅 --api 模式有 */
  engine?: string;
  usedApi?: boolean;
  roundScores?: number[];
  note?: string;
  degrade?: string[];
  /* 仅 --explain 模式有 */
  explain?: ExplainItem[];
  /* v0.9.66：外部检测器（--detector-url）前后分。失败只记原因，不让整篇失败 */
  detectorBefore?: number | null;
  detectorAfter?: number | null;
  /* v0.9.82：语体指数（registerIndex，独立维度不并入代理分）。书面↔口语替换
   * 在 aiScore 上是实测盲区（2/21），这两处让批量报告能看到语体被往哪边推 */
  registerBefore?: { index: number; label: string };
  registerAfter?: { index: number; label: string };
  detectorError?: string;
  /** v0.9.71：多档检测器的逐档结果（单档时就是一条，与顶层字段同源） */
  detectorScores?: DetectorScoreRow[];
  /* v0.9.81：地区用词/标点校正（--variant zh-TW 时才有） */
  regional?: { variant: string; terms: RegionalHit[]; punctuation: number };
}

/** 一档检测器的读数：失败时分数为 null、error 记原因 */
interface DetectorScoreRow {
  url: string;
  before: number | null;
  after: number | null;
  error?: string;
}

/** v0.9.32：report totals 的求和（对全部条目求和，含失败篇目——失败也是花了时间的） */
function sum0(reps: FileReport[], g: (r: FileReport) => number): number {
  return reps.reduce((s, r) => s + g(r), 0);
}

/** v0.9.32：简单 worker 池（--api 并发；本地引擎单线程不走这里） */
async function runPool<T>(
  items: T[],
  jobs: number,
  fn: (item: T, i: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/**
 * v0.9.38：stdin 管道模式主流程。
 *
 * 边界（诚实声明）：
 *  · **只走本地引擎**。LLM 通道（--api）的 cfg 构建与校验在 main 的批量路径里，
 *    不为一把管道把那段重构进这里——要深度模式请把内容落成文件。
 *  · 编码：stdin 是 Node 已解码的 UTF-8 流，不走 readInputText 的
 *    BOM/UTF-16/GBK 探测（那是文件路径场景的能力）。
 *  · 输出分工：**正文一律 stdout、诊断一律 stderr**，`> 重定向` 不会把进度行混进产物。
 *  · --report/--suffix/--out-format 在 stdin 模式无意义（单篇不落盘），忽略。
 */
async function runStdinMode(args: Args): Promise<void> {
  if (args.api) {
    console.error("✗ stdin 模式暂不支持 LLM 通道（--api）：请把内容落成文件再走文件输入");
    process.exit(1);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch (e) {
    console.error(
      `✗ 读标准输入失败：${(e as Error).message}\n  用法示例：cat 稿.txt | ai-humanizer -`,
    );
    process.exit(1);
  }
  if (!raw.trim()) {
    console.error("✗ 标准输入为空（用法示例：cat 稿.txt | ai-humanizer -）");
    process.exit(1);
  }
  // v0.9.52：审题模式优先。stdin 只要痕迹地图——不做改写、不消耗额度、不改一个字
  if (args.detectOnly) {
    process.stdout.write(`${formatReview(reviewText(raw))}\n`);
    return;
  }

  const t0 = Date.now();
  const before = detectAI(raw).probability;
  // 低收益风险 + --skip-low-risk 时原样输出；默认照常改写并给警告。判据与批量路径共用同一入口。
  const stdinAdvice = adviceFor(raw, aiScore(raw).score);
  const stdinLowYield = isLowYieldRisk(raw);
  const stdinSkip = stdinLowYield && args.skipLowRisk;
  const out0 = stdinSkip
    ? raw
    : humanize(raw, {
        intensity: args.intensity,
        seed: args.seed,
        zhuqueMode: args.zhuque,
        style: args.style,
        structural: args.structural,
      });
  // v0.9.81：地区校正只在这条分支显式给了 --variant 才跑，默认路径逐字不变
  // v0.9.84：跳过改写时连地区校正也不跑，保证 stdout 与输入逐字一致
  const regional =
    stdinSkip || args.variant === "none" ? undefined : applyRegionalVariant(out0, args.variant);
  const out = regional ? regional.text : out0;
  if (regional) console.error(`ⓘ 地区校正（${args.variant}）：${formatRegionalSummary(regional)}`);
  // 正文：stdout（保留引擎产出的换行结构，末尾补一个换方便终端查看）
  process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  // 诊断：stderr
  const after = detectAI(out).probability;
  console.error(
    `✅ stdin：${before}→${after}（${Date.now() - t0}ms，${raw.length}→${out.length} 字）`,
  );
  if (stdinSkip) {
    console.error(`⏭ 低收益风险：按 --skip-low-risk 原样输出，未改写`);
  } else {
    if (stdinAdvice.code !== "ok") console.error(`ⓘ ${stdinAdvice.message}`);
    if (stdinLowYield)
      console.error(
        `ⓘ 低收益风险：书面标记密度≤${LOW_YIELD_FORMAL_PER_1K}/千字，规则引擎主要只能动断句和用词，建议先与原文对比再决定要不要用`,
      );
  }
  if (args.explain) {
    const items = explainChanges(raw, out);
    console.error(
      formatExplain(items)
        .split("\n")
        .map((l) => `   ${l}`)
        .join("\n"),
    );
  }
}

/**
 * v0.9.81：学术自检。**不落盘**，只打一份带判定的报告。
 *
 * 退出码是给脚本用的：0 = READY，2 = NOT READY（有阻断项）。1 留给"根本没法跑"（输入缺失/为空）。
 * 判定逻辑全在 `src/engine/academic-check.ts`，这里只负责读输入、跑一遍去味、把报告打出去。
 */
async function runAcademicCheck(args: Args): Promise<void> {
  let raw: string;
  try {
    raw = args.stdin ? fs.readFileSync(0, "utf8") : await readInputText(args.input);
  } catch (e) {
    console.error(`✗ 读输入失败：${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (!raw.trim()) {
    console.error("✗ 输入为空（学术自检需要一篇有内容的稿子）");
    process.exitCode = 1;
    return;
  }

  let candidate: string;
  let mode: string | undefined;

  if (args.against) {
    /**
     * v0.9.81：对比模式。审的是**别人改过的稿**（LLM 深度模式产出、外部改写、合作者改的版本），
     * 引擎不参与——这条路径才最容易真的丢数字、丢引用，也是 `academicAudit` 唯一能判出
     * NOT READY 的实战场（本地引擎自己的产出在 180 组探测里一次都没触发阻断项）。
     */
    try {
      candidate = await readInputText(args.against);
    } catch (e) {
      console.error(`✗ 读对比稿失败（--against）：${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
    if (!candidate.trim()) {
      console.error(`✗ 对比稿为空：${args.against}`);
      process.exitCode = 1;
      return;
    }
    mode = `外部改写稿 vs 原文（引擎未参与）：${path.basename(args.against)} 对标 ${args.stdin ? "stdin" : path.basename(args.input)}`;
  } else {
    // 学术稿默认按 academic 跑；用户显式给了 --style 就尊重他
    const style = args.styleExplicit ? args.style : "academic";
    candidate = humanize(raw, {
      intensity: args.intensity,
      seed: args.seed,
      zhuqueMode: args.zhuque,
      style,
      structural: args.structural,
    });
  }

  const audit = academicAudit(raw, candidate);
  process.stdout.write(`${formatAcademicReport(audit, { style: args.style, intensity: args.intensity, mode })}\n`);
  console.error(
    audit.verdict === "blocked"
      ? `✗ NOT READY：${audit.blockers.length} 个阻断项（退出码 2）`
      : "✅ READY：机器没看见阻断项（退出码 0）",
  );
  process.exitCode = audit.verdict === "blocked" ? 2 : 0;
}

/**
 * v0.9.84：篇章结构审计。**不落盘、不改一个字**，只打「骨架像不像 AI」的清单。
 *
 * 与 `--detect-only` 的分工：后者看**词句**（哪句像 AI、命中哪条规则），
 * 这里看**篇章**（标题承诺兑没兑现、论点在第几段、首尾是否复述）。两者可以同跑，互不依赖。
 *
 * 退出码：0 = 没有 high 项，2 = 至少一处 high（可进 CI 当「别这么发」的闸），1 = 读不到输入。
 * 为什么不直接给个「结构分」：本仓 2026-11-06 的评测已经证明单席绝对分不可复现
 * （同一批文本、同模型同 prompt，隔一天能漂 12 分）。结构层同理——只报可数的命中，
 * 不造第二个没有真值的分数。
 */
async function runStructureAudit(args: Args): Promise<void> {
  const targets: { label: string; text: string }[] = [];

  const readOne = async (f: string): Promise<string> =>
    args.stdin ? fs.readFileSync(0, "utf8") : readInputText(f);

  try {
    if (args.stdin) {
      const raw = await readOne("-");
      if (!raw.trim()) {
        console.error("✗ 标准输入为空（用法示例：cat 稿.txt | ai-humanizer --audit-structure）");
        process.exitCode = 1;
        return;
      }
      targets.push({ label: "stdin", text: raw });
    } else {
      const collected = collectInputFiles(args.input, {
        recursive: args.recursive,
        skipSuffix: args.suffix,
      });
      if (!collected.files.length) {
        console.error(`未找到可审计的文件（支持 ${INPUT_EXTS_LABEL}）: ${args.input}`);
        process.exitCode = 1;
        return;
      }
      for (const f of collected.files) {
        targets.push({ label: path.basename(f), text: await readInputText(f) });
      }
    }
    if (args.against) {
      targets.push({ label: `对比稿 ${path.basename(args.against)}`, text: await readInputText(args.against) });
    }
  } catch (e) {
    console.error(`✗ 读输入失败：${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  let high = 0;
  let mid = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const step = targets.length > 1 ? `[${i + 1}/${targets.length}] ` : "";
    const report = auditStructure(t.text, { style: args.style });
    high += report.issues.filter((x) => x.severity === "high").length;
    mid += report.issues.filter((x) => x.severity === "medium").length;
    console.log(`${step}── ${t.label} ──`);
    console.log(formatStructureReport(report));
    console.log("");
  }

  if (targets.length > 1) {
    console.log(`汇总：${targets.length} 份 · 硬伤 ${high} 处 · 待商榷 ${mid} 处`);
  }
  // 硬伤进退出码：CI 里「结构没收拾好就别发」比一句提示有用
  process.exitCode = high > 0 ? 2 : 0;
}

/**
 * v0.9.85：结构指标（`--metrics`）。**不落盘、不改一个字**，只输出句法统计。
 *
 * 用途：裁决「这次改动到底动了什么」。`aiScore` 与引擎共用词表（自证），
 * 配对盲测在「长文本 + 细微改动」上四次都测不出（0.478/0.457/0.433/0.517），
 * 这里给第三把纯句法尺子：同输入同输出、可 diff、可进证据链。
 *
 * 输出 JSON（`--against` 时附逐项 delta），便于脚本化与归档。
 */
async function runMetrics(args: Args): Promise<void> {
  const targets: { label: string; text: string }[] = [];
  try {
    if (args.stdin) {
      const raw = fs.readFileSync(0, "utf8");
      if (!raw.trim()) {
        console.error("✗ 标准输入为空（用法示例：cat 稿.txt | ai-humanizer --metrics）");
        process.exitCode = 1;
        return;
      }
      targets.push({ label: "stdin", text: raw });
    } else {
      const collected = collectInputFiles(args.input, {
        recursive: args.recursive,
        skipSuffix: args.suffix,
      });
      if (!collected.files.length) {
        console.error(`未找到可统计的文件（支持 ${INPUT_EXTS_LABEL}）: ${args.input}`);
        process.exitCode = 1;
        return;
      }
      for (const f of collected.files) {
        targets.push({ label: path.basename(f), text: await readInputText(f) });
      }
    }
  } catch (e) {
    console.error(`✗ 读输入失败：${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const rows = targets.map((t) => {
    const m = structureMetrics(t.text);
    return { label: t.label, summary: formatMetrics(m), metrics: m };
  });

  let against:
    | { label: string; summary: string; metrics: StructureMetrics; deltaVsFirst: MetricDelta[] }
    | undefined;
  if (args.against) {
    try {
      const m = structureMetrics(await readInputText(args.against));
      against = {
        label: path.basename(args.against),
        summary: formatMetrics(m),
        metrics: m,
        deltaVsFirst: compareMetrics(rows[0].metrics, m),
      };
    } catch (e) {
      console.error(`✗ 读对比稿失败：${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }

  process.stdout.write(JSON.stringify({ targets: rows, against }, null, 2) + "\n");
}

async function main() {
  const args = parseArgs(process.argv);
  // v0.9.40：--help / -h → 用法走 stdout + 退出 0（诊断才走 stderr，帮助不是错误）
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  /**
   * v0.9.66：外部检测器配置。给了 --detector-url 才启用；凭证优先取 flag，其次环境变量
   * （命令行会进 shell 历史，凭证更适合走 QUAIWEI_DETECTOR_KEY）。
   * v0.9.71：`--detector-url` 可重复 —— 每档独立 URL/点路径/刻度，逐档送检做横向对比。
   */
  const detectorCfgs: DetectorConfig[] = args.detectors
    .filter((d) => d.url.trim() !== "")
    .map((d) => {
      // 朱雀官方网关：只给 --detector-url 也自动用官方口径（softmax_confidence / 0-1）。
      // 显式传过 path 或 scale 的以用户为准，避免覆盖自定义检测器。
      const preset =
        d.path === "score" && d.scale === "0-100" ? inferZhuqueDefaults(d.url) : null;
      return {
        enabled: true,
        url: d.url,
        apiKey: d.key || process.env.QUAIWEI_DETECTOR_KEY || "",
        scorePath: preset?.scorePath ?? d.path,
        scale: (preset?.scale ?? d.scale) as "0-100" | "0-1",
      };
    });

  // v0.9.81：学术自检优先于批量流程——它不落盘，只出判定
  if (args.academicCheck) {
    await runAcademicCheck(args);
    return;
  }

  // v0.9.84：结构审计同理——不落盘、不改字，读输入出报告（支持 stdin 与目录）
  if (args.auditStructure) {
    await runStructureAudit(args);
    return;
  }

  // v0.9.85：结构指标同理——不落盘、不改字，只出句法统计（支持 stdin / 文件 / 目录 / --against）
  if (args.metrics) {
    await runMetrics(args);
    return;
  }

  // v0.9.38：stdin 管道模式（输入参数 - 或省略）。省略参数时在这里补判 TTY：
  // 交互终端下不给管道，维持原行为（用法 + 退出），别把用户晾在读取阻塞里。
  if (args.stdin) {
    if (args.input === "-" || !process.stdin.isTTY) {
      await runStdinMode(args);
      return;
    }
    console.error(USAGE);
    process.exit(1);
  }

  // v0.9.32：读不到输入路径时给一句话错误，而不是甩 ENOENT 堆栈
  let collected: { files: string[]; skipped: number };
  try {
    collected = collectInputFiles(args.input, {
      recursive: args.recursive,
      skipSuffix: args.suffix,
    });
  } catch (e) {
    console.error(`✗ 读不到输入路径：${args.input}\n  ${(e as Error).message}`);
    process.exit(1);
  }
  const files = collected.files;
  if (!files.length) {
    console.error(`未找到可处理的文件（支持 ${INPUT_EXTS_LABEL}）:`, args.input);
    process.exit(1);
  }

  // v0.9.32：--dry-run 在 Key 校验/建目录之前返回——预览不该被网关配置挡住，也不该留下空目录
  if (args.dryRun) {
    console.log(
      `试运行（--dry-run）：将处理 ${files.length} 个文件 | 强度 ${args.intensity} | ` +
        `${args.api ? "LLM 通道" : "本地引擎"}${args.recursive ? " | 递归" : ""}（不落盘）`,
    );
    for (const f of files) console.log(`  · ${f}`);
    if (collected.skipped)
      console.log(`（另跳过 ${collected.skipped} 个已带输出后缀「${args.suffix}」的既有产物）`);
    return;
  }
  // v0.9.52：审题模式。位置同 --dry-run——在 Key 校验与建目录之前返回：
  // 看自己的稿子有哪些 AI 味痕迹，不该被网关配置挡住，也不该留下空目录。
  if (args.detectOnly) {
    console.log(
      `审题模式（--detect-only）：${files.length} 个文件 · 只出痕迹地图，一个字都不改、不落盘`,
    );
    console.log("─".repeat(64));
    const reps: ReviewReport[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const name = path.basename(f);
      const step = files.length > 1 ? `[${i + 1}/${files.length}] ` : "";
      try {
        const raw = await readInputText(f);
        if (!raw.trim()) {
          console.log(`${step}⏭  ${name}：空文件，跳过`);
          continue;
        }
        const r = reviewText(raw);
        reps.push(r);
        console.log(`${step}── ${name} ──`);
        console.log(formatReview(r));
        console.log("");
      } catch (e) {
        console.log(`${step}✗  ${name}：读失败（${(e as Error).message}）`);
      }
    }
    if (reps.length > 1) {
      const avg = Math.round(reps.reduce((s, r) => s + r.probability, 0) / reps.length);
      const total = reps.reduce((s, r) => s + r.marked, 0);
      console.log("─".repeat(64));
      console.log(`汇总：${reps.length} 篇 · 平均代理分 ${avg} · 痕迹句合计 ${total}`);
    }
    if (collected.skipped)
      console.log(`（另跳过 ${collected.skipped} 个带输出后缀「${args.suffix}」的产物）`);
    return;
  }

  fs.mkdirSync(args.out, { recursive: true });

  let cfg: ApiConfig | null = null;
  if (args.api) {
    cfg = buildApiConfig(args);
    // CLI 没有 vite / Electron 的同源代理：形如 "/sensenova/v1" 的相对路径在 Node 里必挂，
    // 与其让它在第一次 fetch 时报个看不懂的错，不如现在说清楚。
    if (/^\//.test(cfg.baseUrl)) {
      console.error(
        `✗ baseUrl "${cfg.baseUrl}" 是同源相对路径，CLI 无代理无法使用。\n` +
          `  请填完整地址，例如 --base-url https://token.sensenova.cn/v1`,
      );
      process.exit(1);
    }
    if (baseUrlHasProxyPrefix(cfg.baseUrl)) {
      console.error(
        `✗ baseUrl "${cfg.baseUrl}" 带着同源代理前缀 /sensenova——那是 UI/桌面版给代理用的写法，` +
          `代理会剥掉这段前缀再转发；CLI 直连没有代理，原样发出去会撞网关 404。\n` +
          `  请去掉前缀，例如 --base-url https://token.sensenova.cn/v1`,
      );
      process.exit(1);
    }
    if (!cfg.apiKey.trim()) {
      console.error(
        "✗ 未拿到 API Key。可用方式：--api-key / 环境变量 QUAIWEI_API_KEY / OPENAI_API_KEY / " +
          "SENSENOVA_KEYS / scripts/.sensenova-keys",
      );
      process.exit(1);
    }
    console.log(
      `批量去味（LLM 通道）：${files.length} 个文件 | 强度 ${args.intensity} | ` +
        `${args.deep ? "深度闭环" : "单轮"} | 模型 ${cfg.model}` +
        `${cfg.judgeModel ? ` + 评判 ${cfg.judgeModel}` : ""} | 文风 ${args.style}` +
        `${args.jobs > 1 ? ` | 并发 ${args.jobs}` : ""}`,
    );
  } else {
    console.log(
      `批量去味：${files.length} 个文件 | 强度 ${args.intensity} | 朱雀增强 ${args.zhuque ? "开" : "关"} | 文风 ${args.style}`,
    );
    if (args.jobs > 1)
      console.log("   ⓘ 本地引擎是单线程 CPU 模式，--jobs 仅对 --api 生效，已忽略");
  }
  if (collected.skipped)
    console.log(
      `   ⓘ 已跳过 ${collected.skipped} 个带输出后缀「${args.suffix}」的既有产物（重跑幂等；单文件指名输入不受限）`,
    );
  console.log("─".repeat(64));

  const multi = files.length > 1;
  const reports: FileReport[] = new Array(files.length);
  let ok = 0,
    fail = 0;
  const processOne = async (f: string, idx: number) => {
    const name = path.basename(f);
    const step = multi ? `[${idx + 1}/${files.length}] ` : "";
    try {
      const raw = await readInputText(f);
      if (!raw.trim()) {
        console.log(`${step}⏭  ${name}：空文件，跳过`);
        return;
      }
      const t0 = Date.now();
      const rep: FileReport = {
        file: name,
        ms: 0,
        charsIn: raw.length,
        charsOut: 0,
        detectBefore: detectAI(raw).probability,
        detectAfter: 0,
        registerBefore: briefRegister(registerIndex(raw)),
        ok: true,
      };
      // v0.9.85：--structural 时先记 false，由 onStructuralApplied 回调置 true。
      // 默认 false 也覆盖「守卫全过但没有可换对」与「--api 深度模式不接结构层」两种情形。
      if (args.structural) rep.structuralApplied = false;
      // 低收益风险**可选**原样出稿（--skip-low-risk，默认关）。
      // 判定只放 CLI 入口层——引擎层 adviceFor 仍「只提示不改行为」，
      // regression-12samples 的 H1/H2 基线、Web/MCP/API 消费者行为都不受影响。
      // 判据（src/engine/low-yield.ts）：书面标记密度 formalPer1k≤8/千字，长度归一、不看 aiScore。
      // 为什么换掉 v0.9.84 的 aiScore≤27 && formalHits≤2：
      //   formalHits 是原始次数，字数相关系数 0.958 ⇒ 长文构造性不可能 ≤2；
      //   P1-1 首跑在 21 篇真人长文上 0 命中，反在 23 篇该改短稿上命中 13 篇。
      // 44 篇基准台模拟：新判据命中 15/21、残余误伤率 57%→14%、该改达改率不变；
      // 仍误跳 10 篇该改稿（双网关配对显示改写多半更像人）⇒ 继续 opt-in。
      // ⚠️ 阈值属探索性：两面板长度区间完全不重叠，需补长 AI 稿 / 短真人稿做交叉验证。
      // 开启后仍落盘同名文件（内容=原文），不静默不产出，批量文件数与旧版一致。
      const advice = adviceFor(raw, aiScore(raw).score);
      const lowYieldRisk = isLowYieldRisk(raw);
      rep.lowYieldRisk = lowYieldRisk;
      const didSkip = lowYieldRisk && args.skipLowRisk;
      let out: string;
      if (didSkip) {
        out = raw;
        rep.skippedLowRisk = true;
      } else if (cfg) {
        const r = await runHumanize(
          raw,
          args.intensity,
          cfg,
          (round, score, stage) => {
            console.log(
              `   ${step}${name} ${stage ?? ""}第 ${round} 轮${score === null ? "" : ` 评分 ${score}`}`,
            );
          },
          args.zhuque,
          undefined, // genre 交给引擎自动判定，与 UI「自动」一致
        );
        out = r.text;
        rep.engine = r.engine;
        rep.usedApi = r.usedApi;
        rep.roundScores = r.roundScores;
        rep.note = r.note;
        rep.degrade = r.degrade;
      } else {
        out = humanize(raw, {
          intensity: args.intensity,
          seed: args.seed,
          zhuqueMode: args.zhuque,
          style: args.style,
          structural: args.structural,
          onStructuralApplied: (applied) => {
            rep.structuralApplied = applied;
          },
        });
      }
      rep.ms = Date.now() - t0;
      // v0.9.81：地区校正（--variant）。默认 none，不跑、不记账，产出与之前逐字相同
      if (args.variant !== "none" && !didSkip) {
        const regional = applyRegionalVariant(out, args.variant);
        out = regional.text;
        rep.regional = { variant: args.variant, terms: regional.terms, punctuation: regional.punctuation };
        console.log(`${step}   ⓘ 地区校正：${formatRegionalSummary(regional)}`);
      }
      rep.charsOut = out.length;
      rep.detectAfter = detectAI(out).probability;
      rep.registerAfter = briefRegister(registerIndex(out));
      const ext = outExtOf(f, args.outFormat);
      const dest = path.join(args.out, name.replace(/\.(txt|md|docx)$/i, "") + args.suffix + ext);
      await writeOutput(dest, out, ext === ".docx");
      rep.outPath = dest;
      console.log(
        `${step}✅ ${name}：${rep.detectBefore}→${rep.detectAfter}（${rep.ms}ms，${raw.length}→${out.length} 字）→ ${path.basename(dest)}`,
      );
      if (didSkip) console.log(`   ⏭ 低收益风险：按 --skip-low-risk 原样出稿，未改写`);
      // v0.9.66：外部检测器（任意厂商）——原文与产出各送一次，记前后分。
      // 失败只记原因、不中断：检测器额度/网络问题不该让整批去味白跑。
      // v0.9.71：多档时**逐档**送检，横向对比同一篇在不同检测器下的分数。
      if (detectorCfgs.length > 0) {
        const scores: DetectorScoreRow[] = [];
        for (const [idx, cfg] of detectorCfgs.entries()) {
          const label = detectorCfgs.length > 1 ? `#${idx + 1} ` : "";
          try {
            const before = await scoreViaDetector(raw, cfg);
            const after = await scoreViaDetector(out, cfg);
            scores.push({ url: cfg.url, before, after });
            const delta = after - before;
            console.log(
              `   🔎 外部检测器${label}${cfg.url}：${before} → ${after}（${delta > 0 ? "+" : ""}${delta}，负数=更像人写）`,
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            scores.push({ url: cfg.url, before: null, after: null, error: msg });
            console.log(`   ⚠ 外部检测器${label}失败（不影响出稿）：${msg}`);
          }
        }
        rep.detectorScores = scores;
        // 兼容单档读数：顶层字段取**第一档**的结果（旧报告消费方不用改）
        const first = scores[0];
        if (first) {
          rep.detectorBefore = first.before;
          rep.detectorAfter = first.after;
          if (first.error) rep.detectorError = first.error;
        }
      }
      // 默认路径照常改写、但把「其实不用去味」的警告说出来（文案依据换成独立评委实测）；
      // 低收益风险另补一条机制说明（与 advice 解耦：新判据不看 aiScore）。
      if (!didSkip) {
        if (advice.code !== "ok") console.log(`   ⓘ ${advice.message}`);
        if (lowYieldRisk)
          console.log(
            `   ⓘ 低收益风险：书面标记密度≤${LOW_YIELD_FORMAL_PER_1K}/千字，规则引擎主要只能动断句和用词，建议先与原文对比再决定要不要用`,
          );
      }
      if (args.explain) {
        const items = explainChanges(raw, out);
        rep.explain = items;
        // 缩进两格对齐本篇其他行首的 `   `
        console.log(
          formatExplain(items)
            .split("\n")
            .map((l) => `   ${l}`)
            .join("\n"),
        );
      }
      if (cfg) {
        const tag = rep.engine === "llm" ? "LLM" : rep.engine === "mixed" ? "混拼" : "本地回退";
        const rounds = rep.roundScores?.length ? ` 轮次分 [${rep.roundScores.join(", ")}]` : "";
        console.log(`   ${tag}${rounds}${rep.note ? ` · ${rep.note}` : ""}`);
        for (const d of rep.degrade ?? []) console.log(`   ⚠ ${d}`);
      }
      reports[idx] = rep;
      ok++;
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`${step}❌ ${name}：${msg}`);
      reports[idx] = {
        file: name,
        ms: 0,
        charsIn: 0,
        charsOut: 0,
        detectBefore: 0,
        detectAfter: 0,
        ok: false,
        error: msg,
      };
      fail++;
    }
  };
  // v0.9.32：--api（网络等待型）可并发提速；本地引擎是同步 CPU 活，串行即可
  if (cfg && args.jobs > 1) await runPool(files, args.jobs, processOne);
  else for (let i = 0; i < files.length; i++) await processOne(files[i], i);
  const reps = reports.filter((r): r is FileReport => !!r);

  console.log("─".repeat(64));
  const skippedLow = reps.filter((r) => r.skippedLowRisk).length;
  console.log(
    `完成：${ok} 成功 / ${fail} 失败 → ${args.out}` +
      (skippedLow ? `（其中 ${skippedLow} 篇按 --skip-low-risk 原样出稿、未改写）` : ""),
  );
  // v0.9.32：收尾汇总。detect 是**本地代理分**（与引擎同源词表），只作趋势参考——
  // SKILL.md 里"同源指标非外部真值"的边界同样适用于这行。
  const done = reps.filter((r) => r.ok);
  if (done.length) {
    const sum = (g: (r: FileReport) => number) => done.reduce((s, r) => s + g(r), 0);
    const avg = (g: (r: FileReport) => number) => Math.round(sum(g) / done.length);
    // 语体均值：只在两段都有读数时附加（老报告路径/失败篇不凑数）
    const regPairs = done.filter((r) => r.registerBefore && r.registerAfter);
    const regAvg = (g: (r: FileReport) => number) =>
      Math.round(regPairs.reduce((s, r) => s + g(r), 0) / regPairs.length);
    console.log(
      `汇总：${done.length} 篇 | 引擎耗时 ${sum((r) => r.ms)}ms | ` +
        `字数 ${sum((r) => r.charsIn)}→${sum((r) => r.charsOut)} | ` +
        `AI 味代理分（均值）${avg((r) => r.detectBefore)}→${avg((r) => r.detectAfter)}` +
        (regPairs.length
          ? ` | 语体 ${regAvg((r) => r.registerBefore!.index)}→${regAvg((r) => r.registerAfter!.index)}（书面度，非 AI 味）`
          : ""),
    );
  }

  if (args.report) {
    const rp = path.resolve(args.report);
    fs.mkdirSync(path.dirname(rp), { recursive: true });
    fs.writeFileSync(
      rp,
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          args,
          totals: {
            files: reps.length,
            ok,
            fail,
            skippedSuffix: collected.skipped,
            lowYieldRisk: reps.filter((r) => r.lowYieldRisk).length,
            skippedLowRisk: reps.filter((r) => r.skippedLowRisk).length,
            structuralApplied: reps.filter((r) => r.structuralApplied).length,
            charsIn: sum0(reps, (r) => r.charsIn),
            charsOut: sum0(reps, (r) => r.charsOut),
            msTotal: sum0(reps, (r) => r.ms),
          },
          reports: reps,
        },
        null,
        2,
      ),
      "utf-8",
    );
    console.log(`报告：${rp}`);
  }
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
