/**
 * 十篇小说测试 · 语料生成器
 *
 * 目的：给「去味」做规模测试 — 10 篇 × 约 1 万字的 AI 生成中文小说。
 * 为什么用小说：叙事体裁的句长、对话、专名、数字密度都比论说文高，
 * 且现有回归语料（23 篇真实案例）没有这个量级的长文，能暴露分块接缝问题。
 *
 * 用法：node artifacts/novel-test-1028/gen-novels.mjs
 * 产物：artifacts/novel-test-1028/novels/n01-*.md + meta.json
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "artifacts", "novel-test-1028");
const NOVEL_DIR = path.join(OUT, "novels");
fs.mkdirSync(NOVEL_DIR, { recursive: true });

const BASE = "https://token.sensenova.cn/v1";
const MODEL = "deepseek-v4-flash";
const KEYS = fs
  .readFileSync(path.join(ROOT, "scripts", ".sensenova-keys"), "utf8")
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

const TARGET_CHARS = 10000;
const SEGMENT_CHARS = 2500;
const MAX_SEGMENTS = 6;
const CONCURRENCY = 4;

/** 每篇给死的「保真锚点」：分块改写最容易吃掉的就是数字、门牌、车牌、尾号 */
const SPECS = [
  {
    id: "n01",
    genre: "都市悬疑",
    brief:
      "临江老城拆迁，主角在老楼里找到一封 2003 年没寄出的信，牵出当年的一桩失踪案。",
    anchors: ["2003年9月14日", "B-407", "38.6万元", "京A·7F29", "尾号 8823"],
  },
  {
    id: "n02",
    genre: "硬科幻",
    brief:
      "近地轨道站「渡口」的第七次补给失败，三名宇航员必须在 41 小时内决定谁去修太阳能帆板。",
    anchors: ["41小时", "渡口7号", "距地 386 公里", "氧气余量 62%", "第 3 舱"],
  },
  {
    id: "n03",
    genre: "武侠",
    brief: "镖局少年护送一只木匣过雁门关，匣中不是货，是十年前一桩血案的名单。",
    anchors: ["雁门关", "洪武二十三年", "三百二十两", "第七趟镖", "一只左手"],
  },
  {
    id: "n04",
    genre: "现实主义家庭",
    brief: "母亲住院 27 天，三个子女在缴费窗口前算清了二十年的旧账。",
    anchors: ["27天", "住院押金 5 万元", "19床", "每月 3200 元", "2019年3月17日"],
  },
  {
    id: "n05",
    genre: "校园",
    brief: "高三最后一次模考后，班主任在讲台上烧掉了一张成绩单，全班没人说话。",
    anchors: ["第 4 次模考", "总分 612", "教学楼 3 层", "17 岁", "6月7日"],
  },
  {
    id: "n06",
    genre: "历史演义",
    brief: "康熙三十六年，一名驿卒在暴雨夜把一封军报换成了一封家书。",
    anchors: ["康熙三十六年", "六百里加急", "第三驿站", "二十七人", "一封家书"],
  },
  {
    id: "n07",
    genre: "玄幻",
    brief: "少年在第七次渡劫失败后发现，天雷劈的不是他，是他体内的一枚旧印。",
    anchors: ["第七次渡劫", "三百年前", "九道天雷", "一枚旧印", "十七岁"],
  },
  {
    id: "n08",
    genre: "赛博朋克",
    brief:
      "数据清理工在编号 K-19 的废弃服务器里读到自己的记忆备份，那份备份有两个版本。",
    anchors: ["K-19", "2049年", "第 11 区", "3.5 秒延迟", "两个版本"],
  },
  {
    id: "n09",
    genre: "灾难题材",
    brief: "台风登陆前 6 小时，县医院要转移 84 名病人，而救护车只有 7 辆。",
    anchors: ["6小时", "84 名病人", "7 辆救护车", "红色预警", "海拔 12 米"],
  },
  {
    id: "n10",
    genre: "爱情",
    brief: "两个人约好十年后在老电影院门口见，其中一个提前到了 3 天，另一个迟到了 4 年。",
    anchors: ["十年", "提前 3 天", "迟到 4 年", "光明电影院", "2014年7月8日"],
  },
];

const SYSTEM =
  "你是中文短篇小说作者。只输出小说正文，不要标题、不要小标题、不要分点、不要任何说明文字。" +
  "段落之间用空行分隔。语言自然流畅，人物有具体动作和对话。";

function userPrompt(spec, part, prevTail, soFarChars) {
  const anchorLine = `全文必须自然出现这些具体信息（原样保留，不要改写数字和专名）：${spec.anchors.join("、")}。`;
  if (part === 0) {
    return (
      `请写一篇中文短篇小说《${spec.genre}》的开头部分，约 ${SEGMENT_CHARS} 字。\n` +
      `故事梗概：${spec.brief}\n${anchorLine}\n` +
      `直接进入场景，不要序言式的概括。`
    );
  }
  return (
    `继续写这篇中文短篇小说《${spec.genre}》，约 ${SEGMENT_CHARS} 字，紧接上文往下写。\n` +
    `故事梗概：${spec.brief}\n${anchorLine}\n` +
    `目前约 ${soFarChars} 字。不要复述前文，不要总结，不要收尾式的感叹。\n` +
    `上文结尾（仅供衔接，不要重复）：\n…${prevTail}`
  );
}

function clean(s) {
  return s
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/g, "")
    .replace(/^#+\s.*$/gm, "")
    .replace(/^\*\*.*\*\*$/gm, "")
    .trim();
}

const visible = (s) => s.replace(/\s/g, "").length;

async function chat(messages, maxTokens = 4096) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = KEYS[attempt % KEYS.length];
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature: 0.9,
          max_tokens: maxTokens,
        }),
      });
      const t = await r.text();
      if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 160)}`);
      const j = JSON.parse(t);
      const content = j.choices?.[0]?.message?.content || "";
      // 网关实测会偶发 200 + 空 content：当作可重试失败，不要让它冒充「段落太短」
      if (!content.trim()) throw new Error("空响应（choices[0].message.content 为空）");
      return { content, usage: j.usage || {} };
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** 单段生成：段内自愈（空响应/过短都重试这一小段，不重跑整篇） */
async function segment(spec, part, prevTail, chars) {
  let lastErr;
  let promptTokens = 0;
  let completionTokens = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { content, usage } = await chat(
        [
          { role: "system", content: SYSTEM },
          { role: "user", content: userPrompt(spec, part, prevTail, chars) },
        ],
        4096,
      );
      promptTokens += usage.prompt_tokens || 0;
      completionTokens += usage.completion_tokens || 0;
      const seg = clean(content);
      if (visible(seg) < 300) throw new Error(`段落过短（${visible(seg)} 字）`);
      return { seg, promptTokens, completionTokens };
    } catch (e) {
      lastErr = e;
      console.warn(`  ⚠️ ${spec.id} 段 ${part + 1} 第 ${attempt + 1} 次失败：${e.message}`);
      await sleep(1200 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function buildNovel(spec) {
  const started = Date.now();
  const parts = [];
  let chars = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  for (let part = 0; part < MAX_SEGMENTS; part++) {
    if (chars >= TARGET_CHARS && part >= 4) break;
    if (part >= 4 && chars >= 9000) break;
    const prevTail = parts.join("\n\n").slice(-500);
    const r = await segment(spec, part, prevTail, chars);
    promptTokens += r.promptTokens;
    completionTokens += r.completionTokens;
    parts.push(r.seg);
    chars += visible(r.seg);
    console.log(`  ${spec.id} 段 ${part + 1}: +${visible(r.seg)} → ${chars}`);
    if (chars >= TARGET_CHARS + 600) break;
  }
  const text = parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  const file = path.join(NOVEL_DIR, `${spec.id}-${spec.genre}.md`);
  fs.writeFileSync(file, text, "utf8");
  const rec = {
    id: spec.id,
    genre: spec.genre,
    brief: spec.brief,
    anchors: spec.anchors,
    file: path.relative(ROOT, file).replace(/\\/g, "/"),
    chars: visible(text),
    rawChars: text.length,
    segments: parts.length,
    paragraphs: text.split(/\n{2,}/).filter((p) => p.trim()).length,
    ms: Date.now() - started,
    model: MODEL,
    baseUrl: BASE,
    promptTokens,
    completionTokens,
  };
  console.log(
    `✅ ${spec.id} ${spec.genre}: ${rec.chars} 字 / ${rec.segments} 段 / ${Math.round(rec.ms / 1000)}s / in ${promptTokens} out ${completionTokens}`,
  );
  return rec;
}

async function runPool(items, n, fn) {
  const results = new Array(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (idx < items.length) {
        const i = idx++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

const t0 = Date.now();
console.log(`生成 ${SPECS.length} 篇小说，每篇约 ${TARGET_CHARS} 字，${CONCURRENCY} 路并发，模型 ${MODEL}`);
const recs = await runPool(SPECS, CONCURRENCY, async (spec) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await buildNovel(spec);
    } catch (e) {
      console.error(`⚠️ ${spec.id} 第 ${attempt + 1} 次失败：${e.message}`);
    }
  }
  return null;
});

const meta = {
  ts: new Date().toISOString(),
  model: MODEL,
  baseUrl: BASE,
  targetChars: TARGET_CHARS,
  totalMs: Date.now() - t0,
  novels: recs.filter(Boolean),
  failed: recs.filter((r) => !r).length,
};
fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
const totalChars = meta.novels.reduce((a, r) => a + r.chars, 0);
console.log(
  `\n完成 ${meta.novels.length}/${SPECS.length} 篇 · 合计 ${totalChars} 字 · ${Math.round(meta.totalMs / 1000)}s`,
);
