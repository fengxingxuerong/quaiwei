// 扫同类项目的 star / 最后提交（走 GitHub HTML + commits.atom，绕开 api.github.com 的 60 次/时限额）
//
// 用法：
//   node scripts/scan-github-sector.mjs          行式输出，人看
//   node scripts/scan-github-sector.mjs --md     输出 markdown 表，可直接贴进 README / 竞品周报
//   node scripts/scan-github-sector.mjs --top 20 只出前 20 条
//
// 免责：star 是存量不是增速，GitHub 没有公开的 star 增量接口，本脚本也不估。
// 单个项目取不到（限流 / 改名 / 转私有）不会拖垮整轮，silent 跳过。
import https from "node:https";

// 榜单口径：AI 文本去味 / slop 清理 / 反检测这一类。改这里就是改口径，别在别处另开一份名单。
const REPOS = [
  // 头部（英文为主）
  "blader/humanizer",
  "hardikpandya/stop-slop",
  "petergyang/no-ai-slop",
  "AhmadHassan-BTed/Turnitout-Humanizer",
  // 中文 / 繁体
  "op7418/Humanizer-zh",
  "KKKKhazix/human-writing",
  "larashero3-dotcom/lieflat-less-ai-tone",
  "MrGeDiao/shuorenhua",
  "iniwap/AIWriteX",
  "chi111i/BypassAIGC",
  "hexiecs/talk-normal",
  "Raymondhou0917/speak-human-tw",
  "LifelongLazyLearner/qu-ai-wei",
  "baibanbao/qu-ai-wei",
  "swaylq/humanize-chinese",
  "weiyinerzui/humanize-cn",
  "pengong101/ai-humanizer-cn",
  "qoqu/anti-zhuque",
  "redbaronyyyyy-eng/humanizer-zh-academic",
  "Hyacehila/humanizer-zh-next",
  "junbolian/Academic-Humanizer",
  "orange2ai/renwei-writing",
  "OUBIGFA/De-AI-Prompt-Enhancer-Writer-Booster-SKILL",
  "hylarucoder/ai-flavor-remover",
  // 有独立程序（非 skill）
  "lynote-ai/humanize-text",
  "sgaofen/humanizer-local-model",
  "seyedehsanhadi/sloptrim",
  "humanpen/humanpen-mcp",
  "Nanako0129/sepia",
  "AIScientists-Dev/academic-humanizer",
  "epoko77-ai/im-not-ai",
  "ilyautov/humanizer-ru",
  "devswha/patina",
  "zenstory-ai/oh-story-claudecode",
  // 本仓
  "fengxingxuerong/quaiwei",
];

const UA = { "User-Agent": "Mozilla/5.0" };

function fetchRaw(host, path) {
  return new Promise((res, rej) => {
    https
      .get({ host, path, headers: UA, timeout: 30000 }, (r) => {
        let d = "";
        r.setEncoding("utf8");
        r.on("data", (c) => (d += c));
        r.on("end", () => res(d));
        r.on("error", rej);
      })
      .on("error", rej)
      .on("timeout", function () {
        this.destroy();
        rej(new Error("timeout"));
      });
  });
}

function firstMatch(html, patterns) {
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1];
  }
  return null;
}

async function repo(full) {
  let stars = -1,
    pushed = "?",
    forks = -1;
  try {
    const html = await fetchRaw("github.com", "/" + full);
    const s = firstMatch(html, [/stargazerCount":(\d+)/, /id="repo-stars-counter-star"[^>]*title="([\d,]+)"/]);
    if (s) stars = +String(s).replace(/,/g, "");
    const f = firstMatch(html, [/forkCount":(\d+)/, /id="repo-network-counter"[^>]*title="([\d,]+)"/]);
    if (f) forks = +String(f).replace(/,/g, "");
    const arc = html.match(/"archivedAt":\s*"?([^",}\]]+)/);
    if (arc) pushed = "ARCHIVED " + arc[1].slice(0, 10);
  } catch {
    // 单个项目取不到不该拖垮整轮，silent 跳过后留 stars=-1
  }
  if (pushed === "?") {
    try {
      const atom = await fetchRaw("github.com", "/" + full + "/commits.atom");
      const d = atom.match(/<updated>([^<]+)<\/updated>/);
      if (d) pushed = d[1].slice(0, 10);
    } catch {
      /* ignore */
    }
  }
  return { full, stars, forks, pushed };
}

const argv = process.argv.slice(2);
const asMarkdown = argv.includes("--md");
const topIdx = argv.indexOf("--top");
const top = topIdx >= 0 ? Number(argv[topIdx + 1]) || 0 : 0;

const out = [];
for (let i = 0; i < REPOS.length; i += 6) {
  const batch = REPOS.slice(i, i + 6).map(repo);
  const rs = await Promise.all(batch.map((p) => p.catch(() => null)));
  out.push(...rs.filter(Boolean));
}
out.sort((a, b) => b.stars - a.stars);
const rows = top > 0 ? out.slice(0, top) : out;

if (asMarkdown) {
  console.log(`抓取时间：${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`);
  console.log("");
  console.log("| 项目 | ★ | Fork | 最后提交 |");
  console.log("|---|---:|---:|---|");
  for (const r of rows) {
    console.log(`| [${r.full}](https://github.com/${r.full}) | ${r.stars} | ${r.forks < 0 ? "—" : r.forks} | ${r.pushed} |`);
  }
} else {
  for (const r of rows) {
    console.log(`${String(r.stars).padStart(7)} | ${r.pushed} | f=${String(r.forks).padStart(6)} | ${r.full}`);
  }
}
