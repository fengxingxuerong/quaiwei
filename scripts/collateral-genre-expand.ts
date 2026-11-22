/**
 * collateral-genre-expand.ts —— 体裁混淆分离：把 wiki 体裁 AI 稿从每档 1 篇补到每档 5 篇
 *
 * ## 补的缺口
 *
 * `evidence/collateral-genre-pair-2026-11-12/report.json` 自己写明：同体裁 AI 稿只有 4 篇
 * （600/1200/2400/4800 各 1），逐档 AUC 从 0.4 摆到 0.944，单篇就能把 AUC 拉飞，
 * 「样本不足，不下结论」。本脚本按同一 brief（百科条目体，对齐 H-long 真人维基长条目）
 * 生成 16 篇新稿，使每档达到 5 篇，重跑 `collateral-genre-pair.ts` 才有统计意义。
 *
 * ## 网关
 *
 * 本机 8080 要 proxy key（不可用）；改走 18326 OFM 中继，模型
 * `deepseek-auto/lobsterai/glm-5.3-flash`（GLM 谱系，temperature=0.9 实测正常）。
 * key 从 env `QUAIWEI_EVAL_KEY_A` 或本地 `~/.dsh/our-free-model/settings.json` 读，
 * 不回显、不落盘。并发 2（用户许可 ≤3，留余量防 429）。
 *
 * 用法：npx tsx scripts/collateral-genre-expand.ts
 * 幂等：已存在的目标文件跳过；`--regen` 强制重生成。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(ROOT, "artifacts", "ai-corpus-long");
const BASE_URL = (process.env.QUAIWEI_EVAL_URL_A ?? "http://127.0.0.1:18326").replace(/\/+$/, "");
const MODEL = process.env.QUAIWEI_EVAL_MODEL_A ?? "deepseek-auto/lobsterai/glm-5.3-flash";
const REGEN = process.argv.includes("--regen");
/** 补样模式：首轮 16 篇的实际字数偏大（600 档生成 775~1001），落不进配对脚本 ±35% 窗口。
 *  600 档窗口 390~810 只有 2 篇、1200 档窗口 780~1620 只有 4 篇；补 4 篇严格控字数的短稿。 */
const EXTRA = process.argv.includes("--extra");

/* key 只从 env 或本地设置读，不打印 */
function loadKey(): string {
  const fromEnv = process.env.QUAIWEI_EVAL_KEY_A || process.env.QUAIWEI_API_KEY;
  if (fromEnv) return fromEnv;
  const p = path.join(os.homedir(), ".dsh", "our-free-model", "settings.json");
  if (existsSync(p)) {
    const j = JSON.parse(readFileSync(p, "utf8")) as { chanGateway?: { relay?: { key?: string } } };
    if (j.chanGateway?.relay?.key) return j.chanGateway.relay.key;
  }
  throw new Error("无网关 key：设 QUAIWEI_EVAL_KEY_A 或确保本地 OFM settings 存在");
}
const KEY = loadKey();

/* 4 档 × 4 篇新主题，与原有 4 个主题（候鸟/驿传/茶叶/地下管网）不重复 */
const TARGETS = [600, 1200, 2400, 4800];
const TOPICS: Record<number, string[]> = {
  600: ["珊瑚礁的共生机制", "潮汐能发电的基本原理", "蜜蜂舞蹈语言的信息编码", "古代纺织的提花技术"],
  1200: [
    "季风洋流的形成与影响",
    "青铜器铸造工艺的演变",
    "城市公共交通票制的发展",
    "地震预警系统的工作原理",
  ],
  2400: [
    "红树林湿地生态系统",
    "中国古代水利工程的治理思想",
    "光学显微镜的技术演进",
    "现代港口集装箱装卸体系",
  ],
  4800: [
    "深海热液喷口的生命群落",
    "造纸术向西传播的历程",
    "城市轨道交通网络的规划方法",
    "大气环流模型的建立与应用",
  ],
};
/** v2~v5 共 4 篇/档，加上原有 AI-LONG-wiki-<target>.txt 即每档 5 篇 */
const SUFFIXES = ["v2", "v3", "v4", "v5"];
/** 补样主题（严格控字数，填 600/1200 窗口缺口） */
const EXTRA_TOPICS: Record<number, string[]> = {
  600: [
    "海藻森林的生态功能",
    "古代算盘的结构与算法",
    "沙漠植物的节水适应",
    "候鸟飞行编队的气象适应",
  ],
  1200: [
    "风力发电的气动原理",
    "城市地铁盾构施工技术",
    "疫苗冷链物流的管理规范",
    "传统造纸的纤维处理工艺",
  ],
};

interface ChatMsg {
  role: "system" | "user";
  content: string;
}

async function chat(messages: ChatMsg[], maxTokens: number): Promise<string> {
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, messages, temperature: 0.9, max_tokens: maxTokens }),
      });
      const text = await res.text();
      if (!res.ok) {
        last = `HTTP ${res.status} ${text.slice(0, 120)}`;
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
          continue;
        }
        throw new Error(last);
      }
      const data = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content?.trim() ?? "";
      if (!content) throw new Error("空 content");
      return content;
    } catch (e) {
      last = String((e as Error)?.message ?? e).slice(0, 120);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw new Error(last);
}

/** 与 collateral-ai-long.ts 的 generateOne 同构；strict=true 时强约束字数落在目标 ±25% */
async function generateOne(topic: string, target: number, strict = false): Promise<string> {
  const sys = "你是中文写作者。直接输出正文，不解释，不使用任何 Markdown 标记。";
  const brief = "维基百科条目风格的客观介绍，按主题-背景-发展-现状-影响的结构行文";
  const capHint = strict
    ? `字数必须严格控制在 ${Math.round(target * 0.8)}~${Math.round(target * 1.15)} 字之间，宁短勿长，不要超。`
    : "";
  let body = await chat(
    [
      { role: "system", content: sys },
      {
        role: "user",
        content:
          `写一篇约 ${target} 字的百科条目，主题：${topic}。` +
          `要求：${brief}；${capHint}连贯成段的自然行文，不用标题、不用列表、不用小标题；` +
          `不要出现「作为一个AI」之类的自我说明；只输出正文。`,
      },
    ],
    Math.min(target * 2, 8000),
  );
  for (let round = 1; round <= 3 && body.length < target * (strict ? 0.9 : 0.8); round++) {
    const more = await chat(
      [
        { role: "system", content: sys },
        {
          role: "user",
          content:
            `继续写下面这篇稿子，从中断处自然接着写，不要重复已有内容，不要总结收尾，` +
            `${strict ? `总字数控制在 ${Math.round(target * 1.15)} 字以内，` : ""}只输出新增正文：\n\n${body.slice(-800)}`,
        },
      ],
      Math.min(target * 2, 8000),
    );
    if (!more) break;
    body = `${body}\n${more}`;
  }
  return body.trim();
}

interface Job {
  target: number;
  suffix: string;
  topic: string;
  id: string;
  strict: boolean;
}

/** EXTRA 模式：600 档补 3 篇（窗口 390~810 现只有 2 篇），1200 档补 1 篇（窗口 780~1620 现 4 篇） */
const EXTRA_PLAN: { target: number; slot: number }[] = [
  { target: 600, slot: 0 },
  { target: 600, slot: 1 },
  { target: 600, slot: 2 },
  { target: 1200, slot: 0 },
];
const jobs: Job[] = EXTRA
  ? EXTRA_PLAN.map(({ target, slot }, i) => ({
      target,
      suffix: `x${i + 1}`,
      topic: EXTRA_TOPICS[target][slot],
      id: `AI-LONG-wiki-${target}-x${i + 1}`,
      strict: true,
    }))
  : TARGETS.flatMap((t) =>
      SUFFIXES.map((s, i) => ({
        target: t,
        suffix: s,
        topic: TOPICS[t][i],
        id: `AI-LONG-wiki-${t}-${s}`,
        strict: false,
      })),
    );

async function main(): Promise<void> {
  mkdirSync(CORPUS, { recursive: true });
  const todo = jobs.filter((j) => REGEN || !existsSync(path.join(CORPUS, `${j.id}.txt`)));
  console.log(
    `共 ${jobs.length} 篇，待生成 ${todo.length} 篇（模型 ${MODEL} @ ${BASE_URL}，并发 2）`,
  );

  const results: { id: string; chars: number; ms: number; err?: string }[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < todo.length) {
      const j = todo[cursor++];
      const t0 = Date.now();
      try {
        const text = await generateOne(j.topic, j.target, j.strict);
        const header =
          `来源：${BASE_URL}（模型 ${MODEL}）\n` +
          `体裁：百科条目体（对齐 H-long 体裁，体裁混淆扩样）\n` +
          `目标长度：${j.target} 字；主题：${j.topic}\n` +
          `生成时间：${new Date().toISOString()}\n\n`;
        writeFileSync(path.join(CORPUS, `${j.id}.txt`), header + text + "\n", "utf8");
        results.push({ id: j.id, chars: text.length, ms: Date.now() - t0 });
        console.log(`  ✓ ${j.id}  ${text.length} 字  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        const err = String((e as Error)?.message ?? e).slice(0, 100);
        results.push({ id: j.id, chars: 0, ms: Date.now() - t0, err });
        console.log(`  ✗ ${j.id}  ${err}`);
      }
    }
  }
  await Promise.all([worker(), worker()]);

  const failed = results.filter((r) => r.err);
  console.log(`\n完成 ${results.length - failed.length}/${results.length}；失败 ${failed.length}`);
  for (const t of TARGETS) {
    const band = results.filter((r) => r.id.startsWith(`AI-LONG-wiki-${t}-`));
    /* 配对脚本窗口是 ±35%，这里按同口径判「落在窗口内」 */
    const ok = band.filter((r) => !r.err && r.chars >= t * 0.65 && r.chars <= t * 1.35);
    console.log(`  ${t} 档：落盘 ${band.length} / 窗口内 ${ok.length}`);
  }
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`✗ ${(e as Error)?.message ?? e}`);
  process.exit(1);
});
