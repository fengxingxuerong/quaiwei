/**
 * collateral-cross-fetch.ts —— 抓「短真人稿」，补 P1-1 交叉语料
 *
 * ## 为什么需要
 *
 * 误伤基准台 P1-1 的两面板长度区间完全不重叠：
 *   · no-touch（真人维基长文）2160~27267 字
 *   · should-change（仓内 AI 味案例）53~453 字
 * ⇒ 任何含长度项的判据都会在这份语料上得到虚高分离度（标签泄漏）。
 * `--skip-low-risk` 换成密度判据 `formalPer1k<=8/千字` 后，仍缺「短真人稿」这一象限：
 * 真人写 200~450 字短文时，书面标记密度是不是同样低？不实测就答不了。
 *
 * 本脚本抓中文维基的**短散文条目**（150~460 字），作为短真人稿面板。
 * 标签由来源定义（真人协作撰写的维基条目，非 AI 生成），不靠人判。
 *
 * ## 为什么短条目要过滤列表
 *
 * 首次探测（2026-11-09）命中 5/12 全是「××省中国传统村落列表」这类列表条目——
 * 正文是地名罗列，没有句子结构，`formalPer1k` 与句读指标都无意义。
 * 因此加了三个硬过滤：句号 `。` >= 2、顿号 `、` <= 句号×3、标题不含「列表」。
 *
 * ## 限速
 *
 * api.wikimedia.org 对连续请求会返回 429（正文是纯文本 "You are making too many requests"）。
 * 每条间隔 1.3s，遇到非 JSON 响应退避重试 3 次。
 *
 * 用法：npx tsx scripts/collateral-cross-fetch.ts [--target 14]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAsync } from "./run-async.ts";
import { cleanWikitext, toProse } from "./lib/wikitext.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "artifacts", "human-corpus-short");
const CURL_CANDIDATES = [
  "C:\\Program Files\\Git\\mingw64\\bin\\curl.exe",
  "C:\\Program Files\\Git\\usr\\bin\\curl.exe",
  "curl",
];
const API = "https://api.wikimedia.org/core/v1/wikipedia/zh";
const MIN_CHARS = 150;
const MAX_CHARS = 460;

/** 题材词表：小主题更容易命中小作品级条目（散文而非列表） */
const QUERIES = [
  "拱桥",
  "窑洞",
  "牌坊",
  "梯田",
  "灯塔",
  "运河",
  "瀑布",
  "祠堂",
  "皮影戏",
  "砖雕",
  "木刻",
  "腊染",
  "剪纸",
  "年画",
  "陶器",
  "漆器",
  "竹编",
  "刺绣",
  "风筝",
  "灯谜",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let curlPath: string | null = null;

async function httpGet(url: string): Promise<string> {
  if (!curlPath) {
    for (const c of CURL_CANDIDATES) {
      const probe = await runAsync(c, ["-sS", "-m", "10", "-o", "NUL", "-w", "%{http_code}", `${API}/page/${encodeURIComponent("黄山")}`], {
        timeoutMs: 15_000,
      });
      if (probe.code === 0 && probe.stdout.trim().startsWith("2")) {
        curlPath = c;
        console.log(`[fetch] 可用 curl：${c}\n`);
        break;
      }
    }
    if (!curlPath) throw new Error("没有可用的 curl（api.wikimedia.org 需要走 Git 自带 curl）");
  }
  const r = await runAsync(curlPath, ["-sS", "-m", "25", url], { timeoutMs: 30_000 });
  if (r.code !== 0) return "";
  return r.stdout;
}

/** 429/限流时返回的不是 JSON；退避重试 */
async function getJson<T>(url: string, label: string): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = await httpGet(url);
    if (body.trim().startsWith("{")) {
      try {
        return JSON.parse(body) as T;
      } catch {
        /* 落空重试 */
      }
    }
    const wait = 1500 * (attempt + 1);
    process.stdout.write(`  ${label} 非 JSON，等 ${wait}ms 重试(${attempt + 1}/3)\n`);
    await sleep(wait);
  }
  return null;
}

interface PageRef {
  key: string;
  title: string;
}
interface PageBody {
  source?: string;
  license?: { title: string };
}

/** 列表条目与残句的硬过滤——不做这步，命中率会被地名罗列污染 */
function looksLikeProse(text: string): boolean {
  const periods = (text.match(/。/g) || []).length;
  const commas = (text.match(/[，,]/g) || []).length;
  const enumeration = (text.match(/、/g) || []).length;
  if (periods < 2) return false;
  if (commas < 1) return false;
  if (enumeration > periods * 3) return false;
  // 括号必须配对：剥模板后落单的 `（` 是残句信号（详见 scripts/lib/wikitext.ts）
  if ((text.match(/（/g) || []).length !== (text.match(/）/g) || []).length) return false;
  if ((text.match(/\(/g) || []).length !== (text.match(/\)/g) || []).length) return false;
  return true;
}

async function main(): Promise<void> {
  const tArg = process.argv.indexOf("--target");
  const target = tArg >= 0 ? Number(process.argv[tArg + 1]) : 14;
  mkdirSync(OUT, { recursive: true });

  const seen = new Set<string>();
  const picked: { id: string; title: string; url: string; chars: number; license: string; text: string }[] = [];
  const scanned: { title: string; chars: number; rejected?: string }[] = [];

  // 断点续抓：已落盘的条目不再重复抓，编号从已有最大值顺延
  // （不能数个数——剔除坏样本后个数会回头，覆盖已有文件）
  const existing = existsSync(OUT) ? readdirSync(OUT).filter((f) => /^WIKI-SHORT-\d+\.txt$/.test(f)).sort() : [];
  const baseIndex = existing.reduce((max, f) => Math.max(max, Number(/(\d+)\.txt$/.exec(f)?.[1] ?? 0)), 0);
  // 已抓过的标题进 seen，否则重跑会从头搜同一批词、把同样的条目再抓一遍
  for (const f of existing) {
    const t = /「(.+?)」/.exec(readFileSync(path.join(OUT, f), "utf8"))?.[1];
    if (t) seen.add(t);
  }
  if (existing.length) console.log(`[fetch] 已有 ${existing.length} 篇（最大编号 ${baseIndex}），续抓至 ${target}\n`);

  for (const q of QUERIES) {
    if (existing.length + picked.length >= target) break;
    const search = await getJson<{ pages: PageRef[] }>(`${API}/search/page?q=${encodeURIComponent(q)}&limit=10`, `search:${q}`);
    if (!search?.pages) continue;
    await sleep(1300);

    for (const p of search.pages) {
      if (existing.length + picked.length >= target) break;
      if (seen.has(p.key) || seen.has(p.title)) continue;
      seen.add(p.key);
      if (/列表|消歧义|索引/.test(p.title)) {
        scanned.push({ title: p.title, chars: 0, rejected: "列表/索引类" });
        continue;
      }
      const body = await getJson<PageBody>(`${API}/page/${encodeURIComponent(p.key)}`, `page:${p.title}`);
      await sleep(1300);
      if (!body?.source) {
        scanned.push({ title: p.title, chars: 0, rejected: "取不到 source" });
        continue;
      }
      const prose = toProse(cleanWikitext(body.source), 30);
      if (prose.length < MIN_CHARS) {
        scanned.push({ title: p.title, chars: prose.length, rejected: "太短" });
        continue;
      }
      if (prose.length > MAX_CHARS) {
        scanned.push({ title: p.title, chars: prose.length, rejected: "太长" });
        continue;
      }
      if (!looksLikeProse(prose)) {
        scanned.push({ title: p.title, chars: prose.length, rejected: "非散文（列表/残句）" });
        continue;
      }
      const id = `WIKI-SHORT-${String(baseIndex + picked.length + 1).padStart(2, "0")}`;
      const item = {
        id,
        title: p.title,
        url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(p.title)}`,
        chars: prose.length,
        license: body.license?.title ?? "CC BY-SA 4.0",
        text: prose,
      };
      picked.push(item);
      // 边抓边落盘：本机内存紧张时 spawn 可能中途 UNKNOWN，不能等循环结束再写
      writeFileSync(
        path.join(OUT, `${id}.txt`),
        `【来源】中文维基百科「${p.title}」条目正文\n【URL】${item.url}\n【许可】CC BY-SA 4.0（署名词条标题与 URL）\n【抓取】${new Date().toISOString().slice(0, 10)}\n\n${prose}\n`,
        "utf8",
      );
      console.log(`✅ ${String(prose.length).padStart(4)} 字  ${p.title}  → ${id}`);
    }
  }

  // manifest 从磁盘重建（含本次与历史批次），否则续抓会丢掉前一批的条目
  const files = readdirSync(OUT).filter((f) => /^WIKI-SHORT-\d+\.txt$/.test(f)).sort();
  const items = files.map((f) => {
    const raw = readFileSync(path.join(OUT, f), "utf8");
    const title = /「(.+?)」/.exec(raw)?.[1] ?? "";
    const url = /【URL】(\S+)/.exec(raw)?.[1] ?? "";
    const body = raw.split("\n\n").slice(1).join("\n\n").trim();
    return {
      id: f.replace(/\.txt$/, ""),
      title,
      url,
      chars: body.length,
      file: `artifacts/human-corpus-short/${f}`,
    };
  });

  writeFileSync(
    path.join(OUT, "manifest.json"),
    JSON.stringify(
      {
        source: "中文维基百科（MediaWiki REST API via api.wikimedia.org）",
        license: "CC BY-SA 4.0",
        attribution: "按 CC BY-SA 4.0 署名词条标题与 URL（见 items）",
        purpose: "P1-1 交叉语料：短真人稿面板（长度对齐 should-change 的 53~453 字区间）",
        caveat: "百科体短条目，代表「真人撰写的短说明文」，不代表口语/社交媒体语体",
        fetchedAt: new Date().toISOString(),
        filters: { minChars: MIN_CHARS, maxChars: MAX_CHARS, proseOnly: "句号>=2 且 逗号>=1 且 顿号<=句号x3" },
        items,
        scanned,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const lens = items.map((p) => p.chars).sort((a, b) => a - b);
  console.log(`\n抓取完成：本次 +${picked.length}，库内共 ${items.length}/${target} 篇 → ${path.relative(ROOT, OUT)}`);
  if (lens.length) console.log(`长度：${lens[0]}~${lens[lens.length - 1]} 字，中位 ${lens[Math.floor(lens.length / 2)]}`);
  console.log(`扫描 ${scanned.length} 篇，被拒 ${scanned.filter((s) => s.rejected).length} 篇`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
