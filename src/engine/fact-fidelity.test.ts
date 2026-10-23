/**
 * 事实保真门禁（v0.9.65）—— 对着「内容失真」这一类做的**检出**侧防线
 *
 * 定位：项目把「内容失真」归为"只检出、不能修"（修 = 编造原文）。所以这里不测"改得对不对"，
 * 只测**引擎没有把事实关系改坏**：
 *   · 数字与单位的绑定（`32.68 亿元` 不许变成 `32.68` 或换单位）
 *   · 日期结构（`2026-10-23` / `2026 年 3 月 15 日`）
 *   · 否定词数量（丢一个「不」= 意思反了，是最危险的失真）
 *   · 序数 / 步骤标记的顺序（重排步骤 = 改操作流程）
 *   · 升降方向词数量（把「降 8.6%」写成「升」是硬伤）
 *   · 阈值边界词（不少于 / 不得超过 / 超过 …，丢一个就改了判定口径）
 *
 * 与 `checkFidelityLocal` 的分工：那边是**运行时**给用户看的忠实度报告（数字多重集 + 英文专名），
 * 这边是**开发期**门禁，管的是"绑定关系"这一层——数字还在、但它挂到了错误的单位/方向上。
 */
import { describe, expect, it } from "vitest";
import { fragmentCanStand, humanize } from "./humanize";

const PROSE_FACTS: { name: string; text: string }[] = [
  {
    name: "年报摘要",
    text: "公司 2026 年第三季度实现营业收入 32.68 亿元，同比增长 21.4%，净利润 4.27 亿元，同比下降 8.6%。其中，智能制造板块收入占比 46.2%，较上年同期提升 3.1 个百分点。",
  },
  {
    name: "操作步骤",
    text: "第一步，将设备断电并等待 30 秒；第二步，按住复位键 5 秒直至指示灯呈蓝色常亮；第三步，重新上电并检查网络连接是否正常。",
  },
  {
    name: "新闻快讯",
    text: "据通报，事故造成 3 人轻伤，未造成人员死亡。涉事企业已于 10 月 23 日停产整顿，预计停产 15 天，直接经济损失约 1200 万元。",
  },
  {
    name: "判决书片段",
    text: "本院认为，被告未按合同约定于 2026 年 3 月 15 日前交付货物，构成违约，应于本判决生效之日起十日内支付违约金 45.6 万元。",
  },
  {
    name: "对比说明",
    text: "改造后平均响应时间由 180ms 降至 42ms，缓存命中率从 62.3% 提升到 94.7%，但内存占用上升至 3.8GB，比原方案高出 1.2GB。",
  },
  {
    name: "否定密集",
    text: "该系统不支持离线部署，也不兼容旧版协议，且未通过等保三级认证，因此不能用于生产环境。",
  },
  {
    name: "阈值边界",
    text: "单个文件不得超过 2MB，批量任务最多 30 个，超过 30 个需分批处理；响应时间不少于 200ms 视为异常。",
  },
];

const UNITS =
  "(亿元|万元|亿|万|%|％|毫秒|ms|秒|分钟|小时|天|个|人|次|年|月|日|倍|pp|个百分点|GB|TB|MB)";

/** 数字 + 单位（中间只许有空格）——绑定断了就会被抓出来 */
const unitPairs = (s: string): string[] =>
  [...s.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${UNITS}`, "g"))]
    .map((m) => `${m[1]}${m[2]}`)
    .sort();

const dates = (s: string): string[] =>
  [...s.matchAll(/(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})?\s*日?/g)]
    .map((m) => `${m[1]}-${m[2]}${m[3] ? "-" + m[3] : ""}`)
    .sort();

const negations = (s: string): number => (s.match(/[不未无非别没]/g) ?? []).length;

const upWords = (s: string): number =>
  (s.match(/(提升|提高|上升|增长|增至|上涨|增加|高出|高于)/g) ?? []).length;
const downWords = (s: string): number =>
  (s.match(/(降低|下降|减少|降至|下跌|低于|少于)/g) ?? []).length;

const boundaries = (s: string): string[] =>
  (s.match(/(以上|以下|超过|不足|至少|最多|不少于|不超过|不大于|不小于)/g) ?? []).slice().sort();

const ordinals = (s: string): string[] =>
  (s.match(/(?:第一步|第二步|第三步|第四步|首先|其次|再次|最后|第一|第二|第三)/g) ?? []).slice();

const LEVELS = [0.6, 0.9];
const SEEDS = [7, 20260905];

describe("事实保真：数字 / 日期 / 否定 / 方向 / 边界", () => {
  for (const { name, text } of PROSE_FACTS) {
    it(`${name}：事实关系不被改坏`, () => {
      for (const intensity of LEVELS) {
        for (const seed of SEEDS) {
          const out = humanize(text, { intensity, seed });
          const ctx = `@${intensity} seed=${seed}\n  入：${text}\n  出：${out}`;
          expect(unitPairs(out), `数字-单位绑定变了 ${ctx}`).toEqual(unitPairs(text));
          expect(dates(out), `日期结构变了 ${ctx}`).toEqual(dates(text));
          expect(negations(out), `否定词数量变了 ${ctx}`).toBe(negations(text));
          expect(upWords(out), `上升方向词变了 ${ctx}`).toBe(upWords(text));
          expect(downWords(out), `下降方向词变了 ${ctx}`).toBe(downWords(text));
          expect(boundaries(out), `阈值边界词变了 ${ctx}`).toEqual(boundaries(text));
          expect(ordinals(out), `序数/步骤标记序列变了 ${ctx}`).toEqual(ordinals(text));
        }
      }
    });
  }
});

describe("事实保真定点回归（v0.9.65）", () => {
  it("比较状语不作独立句：「比原方案高出 1.2GB」不许自成一句", () => {
    const src =
      "改造后平均响应时间由 180ms 降至 42ms，缓存命中率从 62.3% 提升到 94.7%，但内存占用上升至 3.8GB，比原方案高出 1.2GB。";
    for (let seed = 1; seed <= 20; seed++) {
      const out = humanize(src, { intensity: 0.9, seed });
      expect(out, `seed=${seed} 出现「句末标点 + 比/较」的无主残句：${out}`).not.toMatch(
        /[。！？]\s*[比较]/,
      );
    }
  });

  it("比较状语守卫：结果型谓词与光杆形容词都判「不可独立」", () => {
    for (const s of [
      "比原方案高出 1.2GB",
      "比去年多了三成",
      "较上年同期增长 21.4%",
      "比预期低",
      "较原方案高",
    ]) {
      expect(fragmentCanStand(s), `「${s}」应判为承前残句`).toBe(false);
    }
    // 反向：不带比较状语的完整句照常可独立；名词短语不因「比」字被误伤
    expect(fragmentCanStand("内存占用上升到 3.8GB")).toBe(true);
    expect(fragmentCanStand("比赛已经开始")).toBe(true);
  });

  it("单位不会被插进垫词而脱离数字", () => {
    const src = "本次改造把平均响应时间压到 42ms，命中率提升到 94.7%。";
    for (let seed = 1; seed <= 10; seed++) {
      const out = humanize(src, { intensity: 0.9, seed });
      expect(out, `seed=${seed}`).toContain("42ms");
      expect(out, `seed=${seed}`).toContain("94.7%");
    }
  });
});
