/**
 * register-metrics.ts —— 语体指数 registerIndex（独立维度，**不并入 aiScore**）
 *
 * ## 为什么要有这个维度（2026-10-14 判别力实验的盲区）
 *
 * artifacts/human-corpus/probe-inject.ts 在 21 篇真人文本上实测：
 *   · 注入 AI 套话（正向·应升）：19/21 方向正确（Δ +14.6）；
 *   · 书面体改口语体（反向·应降）：**2/21（Δ −0.6）**。
 * 原因：aiScore 的检测项（套话词表 / 病词 / 孤立连接词 / 垫词独句 / 句长节奏）
 * 全部只对**词表命中的套话与结构缺陷**敏感——「大致→差不多」「倘若→要是」这类
 * 纯语体替换不进任何检测器，分数纹丝不动。
 *
 * ## 为什么不直接给 aiScore 加权重
 *
 * 书面 ≠ AI。真人写的政务报告、维基正文、技术文档本来就满是书面标记
 * （humanize-metrics.ts 已知灰区 H6/H8 的教训：继续上调权重会把真人正式文本
 * 推进「可疑带」，那是真误伤）。且 aiScore 的 x 轴已被 18 个送检锚点标定、
 * 带棘轮门禁（test:calib）——动它的口径等于要求先重做官方标定。
 * 所以语体做成**并列的第二把尺**：同一篇稿前后对比有意义，跨文本绝对值照样不可比。
 *
 * ## 口径
 *
 *   index = clamp(0, 100, 50 + 50·min(f, CAP)/CAP − 50·min(c, CAP)/CAP)，CAP = 8/千字
 *
 *   · f / c：书面 / 口语标记的每千字命中密度（长度归一，分母只数 CJK）。
 *   · **线性带顶**而不是差值的 tanh——后者在 1:1 词面互换下差值不变
 *     （f+c 守恒 ⇒ f−c 守恒），「口语→书面」方向会整个失效；线性带顶下
 *     每跨边界换一对词，两侧贡献各动一格，两个方向都有梯度。
 *   · 50 为中性，±50 处封顶；CAP=8/千字 意为每千字 8 个标记即给满单向权重。
 *   · 标签带（给 UI/报告用）：≥80 公文/书面腔浓，60~79 偏书面，40~59 中性，
 *     20~39 偏口语，<20 口语。
 *
 * ## 诚实边界
 *
 *   · 它测的是**语体书面度**，不是「像不像 AI 写」——真人公文会得高分，
 *     这与 aiScore 的「高分≈有套话」互补，两把尺合读才有信息量。
 *   · 词表是简中的；英文/繁中不在调优范围内（与引擎主边界一致）。
 *   · 与任何检测器官方分无标定关系。
 */

/* ------------------------------ 词表 ------------------------------ */

/**
 * 书面/公文标记词。覆盖三类：
 *   ① 文言连接词/副词（然而/从而/倘若/诸多/颇为…）
 *   ② 公文动词与政绩腔（贯彻落实/统筹/压实/赋能/抓手…）
 *   ③ probe-inject 双向替换表里的书面侧词（大致/尤其/较为/尚未/随即…）
 *      ——保证与判别力实验同口径，方向测试可复现。
 * 有意收录部分「正常新闻也高频」的词（推进/完善）：本指标量的是语体，
 * 不是 AI 味，召回优先，误报由「量的是语体」这一定位兜底。
 */
const FORMAL_MARKERS: string[] = [
  // 文言单字（直配安全集——逐个核过复合词噪声：
  //   「亦/均/皆/倘/殊/尤/甚/颇/此/则」的常见复合词（甚至/尤其/因此/否则/诸多…）
  //   本身就是书面侧，噪声与信号同向；「之/其/该/即」死配会命中
  //   「之后/其实/应该/立即」这类口语高频词，已换成双字形式，绝不直配。
  // 2026-11-03 真人语料实测补入：没有这组，维基正文基线只落中性带（48~56），
  // 与"百科正文是书面语"的常识相悖——这组把基线抬进偏书面带，量纲才成立。
  "亦",
  "均",
  "皆",
  "倘",
  "殊",
  "尤",
  "甚",
  "颇",
  "此",
  "则",
  // 文言双字替代形式（之/其/该/即 的安全版）
  "其中",
  "之一",
  "及其",
  "反之",
  "乃至",
  "即可",
  "即便",
  "介于",
  // 文言连接词 / 副词
  "然而",
  "从而",
  "进而",
  "因而",
  "故而",
  "亦",
  "均",
  "皆",
  "颇为",
  "较为",
  "极为",
  "尤为",
  "殊",
  "大抵",
  "大凡",
  "诸如",
  "诸多",
  "若干",
  "倘若",
  "倘若如此",
  "以便",
  "业已",
  "已然",
  "尚未",
  "未曾",
  "亟须",
  "亟待",
  "所谓",
  "换言之",
  "概言之",
  "质言之",
  "要而言之",
  "鉴于此",
  "与此同时",
  "与此相对",
  "综上所述",
  "综上",
  // probe-inject FORMAL_MAP 书面侧（与实验同口径）
  "大致",
  "尤其",
  "较为",
  "随后",
  "当即",
  "随即",
  "原本",
  // 公文动词 / 政绩腔
  "贯彻落实",
  "贯彻落实",
  "切实",
  "扎实",
  "深入开展",
  "全面推进",
  "着力",
  "统筹",
  "压实",
  "健全",
  "夯实",
  "聚焦",
  "立足",
  "依托",
  "围绕",
  "赋能",
  "抓手",
  "闭环",
  "全链路",
  "新动能",
  "里程碑",
  "注入新",
  "迈上新台阶",
  "高质量发展",
  "深入推进",
  "持续发力",
  "精准施策",
  "多措并举",
  // 学术/技术书面腔
  "基于上述",
  "基于此",
  "由此可见",
  "不难看出",
  "值得注意的是",
  "需要指出的是",
  "从…来看",
  "就…而言",
  "在一定程度上",
  "具有重要意义",
  "发挥着重要作用",
];

/** 口语标记词。probe-inject 口语侧 + 常见口语词/儿化语气成分 */
const COLLOQUIAL_MARKERS: string[] = [
  // probe-inject 口语侧（与实验同口径）
  "差不多",
  "特别",
  "挺好",
  "挺",
  "还没",
  "接着",
  "赶紧",
  "顺手",
  "原来",
  "好多",
  "要是",
  "一堆",
  "好让",
  "要真是这样",
  // 常见口语词
  "貌似",
  "反正",
  "说白了",
  "说真的",
  "讲真",
  "搞",
  "弄",
  "琢磨",
  "寻思",
  "压根",
  "拉倒",
  "甭",
  "咋",
  "啥",
  "咱们",
  "俺",
  "得嘞",
  "完事儿",
  "麻溜",
  "利索",
  "舒坦",
  "忒",
  "蛮好",
  "老鼻子",
  "一大坨",
  "一坨",
];

/** 去重（上表若手滑重复，构造期一次性收敛，避免计分翻倍） */
const FORMAL_SET = [...new Set(FORMAL_MARKERS)];
const COLLOQUIAL_SET = [...new Set(COLLOQUIAL_MARKERS)];

/* ------------------------------ 口径 ------------------------------ */

/** 每千字封顶密度：达到即给满单向权重（8 个/千字 ≈ 平均每 125 字一个标记） */
const CAP_PER_1K = 8;
/** 单向满权重（±50，使 50 为中性） */
const AMP = 50;

export interface RegisterReport {
  /** 语体指数 0~100：50 中性，越高越书面，越低越口语 */
  index: number;
  /** 标签带（给 UI / 报告直接展示） */
  label: string;
  /** 书面标记命中数（原始次数） */
  formalHits: number;
  /** 口语标记命中数（原始次数） */
  colloquialHits: number;
  /** 书面标记密度（每千字） */
  formalPer1k: number;
  /** 口语标记密度（每千字） */
  colloquialPer1k: number;
  /** 实际参与统计的字符数（CJK 为主；长度归一的分母） */
  countedChars: number;
}

const BANDS: [min: number, label: string][] = [
  [80, "公文/书面腔浓"],
  [60, "偏书面"],
  [40, "中性"],
  [20, "偏口语"],
  [0, "口语"],
];

function labelOf(index: number): string {
  for (const [min, label] of BANDS) {
    if (index >= min) return label;
  }
  return BANDS[BANDS.length - 1][1];
}

/** 统计分母：只数 CJK 字符。拉丁/数字/空白/标点不摊薄密度（英文夹注不该把语体冲淡） */
function countCJK(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x4e00 && c <= 0x9fff) n++;
  }
  return n;
}

function countHits(text: string, words: string[]): number {
  let hits = 0;
  for (const w of words) {
    // 全表统一直配（substring）。单字词已逐个核过复合词噪声（见 FORMAL_MARKERS
    // 注释）——凡直配会命中口语高频词的单字一律不收，宁缺毋滥。
    let i = text.indexOf(w);
    while (i >= 0) {
      hits++;
      i = text.indexOf(w, i + w.length);
    }
  }
  return hits;
}

/**
 * 语体指数。纯函数、确定性、零依赖，浏览器 / Node 直接跑。
 * 同一篇稿前后对比有意义；**跨文本绝对值不可比**（与 aiScore 同一条边界）。
 */
export function registerIndex(text: string): RegisterReport {
  const countedChars = countCJK(text);
  if (countedChars === 0) {
    return {
      index: 50,
      label: "中性",
      formalHits: 0,
      colloquialHits: 0,
      formalPer1k: 0,
      colloquialPer1k: 0,
      countedChars: 0,
    };
  }
  const formalHits = countHits(text, FORMAL_SET);
  const colloquialHits = countHits(text, COLLOQUIAL_SET);
  const formalPer1k = (formalHits / countedChars) * 1000;
  const colloquialPer1k = (colloquialHits / countedChars) * 1000;
  const index = Math.round(
    50 +
      AMP * (Math.min(formalPer1k, CAP_PER_1K) / CAP_PER_1K) -
      AMP * (Math.min(colloquialPer1k, CAP_PER_1K) / CAP_PER_1K),
  );
  return {
    index: Math.max(0, Math.min(100, index)),
    label: labelOf(index),
    formalHits,
    colloquialHits,
    formalPer1k: Number(formalPer1k.toFixed(2)),
    colloquialPer1k: Number(colloquialPer1k.toFixed(2)),
    countedChars,
  };
}

/** 词表只读暴露：探针脚本与测试要与实验同口径时直接引用，别再抄一份 */
export const REGISTER_MARKERS = {
  formal: FORMAL_SET,
  colloquial: COLLOQUIAL_SET,
} as const;
