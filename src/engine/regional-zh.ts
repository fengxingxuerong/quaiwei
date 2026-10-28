/**
 * src/engine/regional-zh.ts —— 地区用词与标点校正（目前只有 zh-TW 一种）。
 *
 * 为什么单独一个 pass，而不是塞进 humanize()：
 *  humanize() 的产出挂在标定棘轮上（x 轴一动，`npm run test:calib` 的 18 个点就漂）。
 *  地区用词不是"去 AI 味"，它是"给台湾读者看"——两件事混在一起，改一个动另一个。
 *  所以这里是**离线的后处理**：humanize() 照旧，调用方显式给 `--variant zh-TW` 才跑。
 *
 * 边界（写进 README 与 docs，不要在外面替它夸口）：
 *  · **不做简繁转换**。字形是 OpenCC 的活，手写一张表出来只会得到混合字形。
 *    本模块只换「词」和「标点」，输入是简体，输出也是简体；繁体稿这个 pass 不适用。
 *  · 只换**无歧义**的词。`程序`（可能是 procedure）、`质量`（可能是 mass）、
 *    `文件`（可能是公文）这类一个词两义的，一律不进表——宁可少换，不要换错。
 *  · 代码块、行内代码、URL、邮箱一律不动（复用 text-shield 的区间表）。
 */
import { codeSpans, spanGuard, structuredSpans, type TextSpan } from "./text-shield";

/** 目前只做台湾用词；将来加 zh-HK 时在这里扩联合类型 */
export type ZhVariant = "zh-TW";

/** 一条替换规则：大陆写法 → 台湾写法（简体字形） */
interface TermEntry {
  cn: string;
  tw: string;
}

/**
 * 词表：只收**无歧义**的词。
 * 排序在模块加载时按长度倒序 —— 「视频会议」必须先于「视频」命中，否则会拼出「影片会议」。
 */
const TERMS: TermEntry[] = [
  // 信息技术
  { cn: "视频会议", tw: "视讯会议" },
  { cn: "互联网", tw: "网际网路" },
  { cn: "人工智能", tw: "人工智慧" },
  { cn: "数字化", tw: "数位化" },
  { cn: "云存储", tw: "云端储存" },
  { cn: "移动硬盘", tw: "行动硬碟" },
  { cn: "打印机", tw: "印表机" },
  { cn: "复印机", tw: "影印机" },
  { cn: "数据库", tw: "资料库" },
  { cn: "文件夹", tw: "资料夹" },
  { cn: "服务器", tw: "伺服器" },
  { cn: "分辨率", tw: "解析度" },
  { cn: "视频", tw: "影片" },
  { cn: "音频", tw: "音讯" },
  { cn: "信息", tw: "资讯" },
  { cn: "打印", tw: "列印" },
  { cn: "复印", tw: "影印" },
  { cn: "网络", tw: "网路" },
  { cn: "鼠标", tw: "滑鼠" },
  { cn: "硬盘", tw: "硬碟" },
  { cn: "内存", tw: "记忆体" },
  { cn: "软件", tw: "软体" },
  { cn: "硬件", tw: "硬体" },
  { cn: "屏幕", tw: "萤幕" },
  { cn: "默认", tw: "预设" },
  { cn: "设置", tw: "设定" },
  { cn: "账号", tw: "帐号" },
  { cn: "登录", tw: "登入" },
  { cn: "短信", tw: "简讯" },
  { cn: "优盘", tw: "随身碟" },
  { cn: "刷新", tw: "重新整理" },
  // 生活与出行
  { cn: "出租车", tw: "计程车" },
  { cn: "地铁", tw: "捷运" },
  { cn: "自行车", tw: "脚踏车" },
  { cn: "方便面", tw: "泡面" },
  { cn: "酸奶", tw: "优格" },
  { cn: "宾馆", tw: "饭店" },
  { cn: "西红柿", tw: "番茄" },
  { cn: "菠萝", tw: "凤梨" },
].sort((a, b) => b.cn.length - a.cn.length);

/** 词表快照，给测试与文档用（避免测试硬抄一份表） */
export function regionalTerms(): readonly TermEntry[] {
  return TERMS;
}

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/** 半角 → 全角：只在两侧都是中文时才换（`3,000`、`v1.2`、`Hello, world` 都不动） */
const PUNCT: Record<string, string> = {
  ",": "，",
  ";": "；",
  ":": "：",
  "?": "？",
  "!": "！",
};

export interface RegionalHit {
  from: string;
  to: string;
  count: number;
}

export interface RegionalResult {
  text: string;
  /** 命中的词条与次数，按词表顺序（长词在前） */
  terms: RegionalHit[];
  /** 半角标点改成全角的处数 */
  punctuation: number;
}

/** 把文本按「受保护区 / 正文区」切开，只有正文区参与替换 */
function runs(text: string, guard: (i: number) => boolean): { text: string; safe: boolean }[] {
  const out: { text: string; safe: boolean }[] = [];
  if (!text) return out;
  let cur = "";
  let curSafe = !guard(0);
  for (let i = 0; i < text.length; i++) {
    const safe = !guard(i);
    if (safe !== curSafe) {
      if (cur) out.push({ text: cur, safe: curSafe });
      cur = "";
      curSafe = safe;
    }
    cur += text[i];
  }
  if (cur) out.push({ text: cur, safe: curSafe });
  return out;
}

function convertPunct(run: string): { text: string; n: number } {
  let out = "";
  let n = 0;
  for (let i = 0; i < run.length; i++) {
    const ch = run[i];
    const prev = run[i - 1] ?? "";
    let next = run[i + 1] ?? "";
    // 半角标点后面常跟一个空格（"元, 版本"）：把空格一起吞掉，别产出「， 」这种半吊子
    let eatSpace = false;
    if (next === " " && i + 2 < run.length) {
      next = run[i + 2];
      eatSpace = true;
    }
    const wide = PUNCT[ch];
    if (wide) {
      const tailOk =
        ch === "?" || ch === "!"
          ? next === "" || CJK.test(next) || /["'”’)）]/.test(next)
          : CJK.test(next);
      if (CJK.test(prev) && tailOk) {
        out += wide;
        if (eatSpace) i++;
        n++;
        continue;
      }
    }
    if (ch === "." && CJK.test(prev) && (next === "" || CJK.test(next))) {
      out += "。";
      if (eatSpace) i++;
      n++;
      continue;
    }
    if (ch === "(" && CJK.test(next)) {
      out += "（";
      n++;
      continue;
    }
    if (ch === ")" && CJK.test(prev)) {
      out += "）";
      n++;
      continue;
    }
    out += ch;
  }
  return { text: out, n };
}

/**
 * 跑一遍地区校正。
 *
 * 传 `variant` 才动文本；`undefined`/空文本原样返回（默认路径零开销、零行为变化）。
 * 这是「默认关闭」的落点：CLI 只在 `--variant zh-TW` 时调它。
 */
export function applyRegionalVariant(text: string, variant?: ZhVariant): RegionalResult {
  if (!text || variant !== "zh-TW") return { text, terms: [], punctuation: 0 };

  const spans: TextSpan[] = [...codeSpans(text), ...structuredSpans(text)];
  const guard = spanGuard(spans);

  const hits = new Map<string, RegionalHit>();
  let punctuation = 0;

  const rebuilt = runs(text, guard)
    .map((r) => {
      if (!r.safe) return r.text;
      let chunk = r.text;
      for (const t of TERMS) {
        let idx = chunk.indexOf(t.cn);
        while (idx >= 0) {
          chunk = chunk.slice(0, idx) + t.tw + chunk.slice(idx + t.cn.length);
          const prev = hits.get(t.cn);
          if (prev) prev.count++;
          else hits.set(t.cn, { from: t.cn, to: t.tw, count: 1 });
          idx = chunk.indexOf(t.cn, idx + t.tw.length);
        }
      }
      const p = convertPunct(chunk);
      punctuation += p.n;
      return p.text;
    })
    .join("");

  return { text: rebuilt, terms: [...hits.values()], punctuation };
}

/** 一行给人看的摘要：`剩 0 处` / `换了 3 处（信息→资讯、软件→软体）· 标点 2 处` */
export function formatRegionalSummary(r: RegionalResult): string {
  const parts: string[] = [];
  if (r.terms.length) {
    const total = r.terms.reduce((s, x) => s + x.count, 0);
    const shown = r.terms
      .slice(0, 4)
      .map((x) => `${x.from}→${x.to}${x.count > 1 ? `×${x.count}` : ""}`)
      .join("、");
    parts.push(`用词换了 ${total} 处（${shown}${r.terms.length > 4 ? " 等" : ""}）`);
  } else {
    parts.push("用词没命中可换的词条");
  }
  parts.push(`标点 ${r.punctuation} 处`);
  return parts.join(" · ");
}
