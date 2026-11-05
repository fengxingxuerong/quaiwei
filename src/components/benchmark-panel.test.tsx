// @vitest-environment happy-dom
/**
 * BenchmarkPanel 渲染级测试：对标评分面板的双通道按钮、引擎体裁联动
 * （自动识别 / 手动 override / 回到自动 / 引擎上抛）、朱雀送检回填行。
 * v0.9.83：官方分预测（v3 18 点 OLS）已随标定子系统移除，预测类用例一并摘除。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { BenchmarkPanel } from "./BenchmarkPanel";
import { DEFAULT_API } from "../api/llm-config";
import { DEFAULT_DETECTOR } from "../api/detector";
import type { ScoreBreakdown } from "../engine/humanize";

afterEach(() => cleanup());

const EXPO_TEXT =
  "值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。从长远来看，建立完善的监管体系，推动可持续发展，具有十分重要的意义。";

/** 叙事文样本：自动识别走 rule 3 → narrative，且满足「疑似纯人写原稿」快捷按钮的
 *  特征门槛（narPastRatio 0.089 ≥ 0.04、expoScore 0.15 < 0.35、dlgColonRatio 0 < 0.03） */
const NARR_TEXT =
  "去年春天我去了苏州旅行。到了古镇以后，我们住在一家小旅馆里，老板娘端上了桂花糕。我和朋友沿着河边散步，聊到很晚才回房。第二天我们又去了园林，在假山旁拍了很多照片。回到旅馆时已经下起了小雨，屋檐下的水滴声让人想起从前的日子。";

const after: ScoreBreakdown = {
  score: 20,
  formulaicHits: 2,
  burstiness: 0.4,
  avgLen: 20,
  sentenceCount: 5,
};

function base(overrides: Partial<Parameters<typeof BenchmarkPanel>[0]> = {}) {
  return {
    output: EXPO_TEXT,
    after,
    roundScores: [] as number[],
    judging: false,
    detecting: false,
    api: { ...DEFAULT_API },
    detector: { ...DEFAULT_DETECTOR },
    judgeScore: null,
    judgeCritique: [] as string[],
    detectorScore: null,
    zhuqueManualScore: "",
    onJudge: vi.fn(),
    onDetect: vi.fn(),
    onManualScore: vi.fn(),
    onGenreChange: vi.fn(),
    onNote: vi.fn(),
    ...overrides,
  };
}

describe("BenchmarkPanel（对标评分面板）", () => {
  it("output 为空时整块不渲染", () => {
    const { container } = render(<BenchmarkPanel {...base({ output: "" })} />);
    expect(container.textContent).toBe("");
  });

  it("渲染标题与本地套话指数；双通道按钮在未配置时禁用", () => {
    const { getByText } = render(<BenchmarkPanel {...base()} />);
    expect(getByText("评分与外部验证（本地分为套话指数，非朱雀官方分）")).toBeTruthy();
    expect(getByText("20")).toBeTruthy();
    const judge = getByText("用 LLM 评判").closest("button") as HTMLButtonElement;
    const detect = getByText("用外部检测器").closest("button") as HTMLButtonElement;
    expect(judge.disabled).toBe(true);
    expect(detect.disabled).toBe(true);
  });

  it("API/检测器配置后按钮可用并触发回调；结果分显示", () => {
    const onJudge = vi.fn();
    const onDetect = vi.fn();
    const p = base({
      api: { ...DEFAULT_API, enabled: true, apiKey: "sk-x" },
      detector: { ...DEFAULT_DETECTOR, enabled: true, url: "https://d/api" },
      judgeScore: 35,
      judgeCritique: ["口语对仗"],
      detectorScore: 60,
      onJudge,
      onDetect,
    });
    const { getByText } = render(<BenchmarkPanel {...p} />);
    fireEvent.click(getByText("用 LLM 评判"));
    fireEvent.click(getByText("用外部检测器"));
    expect(onJudge).toHaveBeenCalledTimes(1);
    expect(onDetect).toHaveBeenCalledTimes(1);
    expect(getByText("LLM 评判：35")).toBeTruthy();
    expect(getByText("检测器：60")).toBeTruthy();
    expect(getByText(/残留痕迹：口语对仗/)).toBeTruthy();
  });

  it("评判中/检测中状态：按钮换文案且禁用，点击不触发回调", () => {
    const onJudge = vi.fn();
    const onDetect = vi.fn();
    const p = base({
      api: { ...DEFAULT_API, enabled: true, apiKey: "sk-x" },
      detector: { ...DEFAULT_DETECTOR, enabled: true, url: "https://d/api" },
      judging: true,
      detecting: true,
      onJudge,
      onDetect,
    });
    const { getByText } = render(<BenchmarkPanel {...p} />);
    const judge = getByText("评判中…").closest("button") as HTMLButtonElement;
    const detect = getByText("检测中…").closest("button") as HTMLButtonElement;
    expect(judge.disabled).toBe(true);
    expect(detect.disabled).toBe(true);
    fireEvent.click(judge);
    fireEvent.click(detect);
    expect(onJudge).not.toHaveBeenCalled();
    expect(onDetect).not.toHaveBeenCalled();
  });

  it("深度轮次分渲染（含失败轮显示「失败」与目标分）", () => {
    const { getByText } = render(<BenchmarkPanel {...base({ roundScores: [60, -1, 25] })} />);
    expect(getByText(/60 → 失败 → 25/)).toBeTruthy();
    expect(getByText(/目标 ≤10/)).toBeTruthy();
  });

  it("不渲染任何官方分预测（标定子系统已移除）", () => {
    const { container } = render(<BenchmarkPanel {...base()} />);
    const t = container.textContent ?? "";
    expect(t).not.toContain("朱雀分趋势预测");
    expect(t).not.toContain("参考线");
    expect(t).not.toContain("建议行动");
    expect(t).not.toContain("实验性换算");
  });

  it("自动识别徽章显示体裁（论说文）且默认体裁为 main", () => {
    const { container } = render(<BenchmarkPanel {...base()} />);
    expect(container.textContent).toContain("🤖 自动识别");
    expect(container.textContent).toContain("论说文");
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("main");
  });

  it("手动切到对话体裁：上抛引擎、显示「手动体裁」与「回到自动」", () => {
    const onGenreChange = vi.fn();
    const { container } = render(<BenchmarkPanel {...base({ onGenreChange })} />);
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "dialogue" } });
    expect(onGenreChange).toHaveBeenCalledWith("dialogue");
    expect(container.textContent).toContain("⚙️ 手动体裁");
    const reset = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("回到自动"),
    ) as HTMLButtonElement;
    expect(reset).toBeTruthy();
  });

  it("手动切回与自动识别一致的体裁：override 被解除、徽章回到「自动识别」", () => {
    const onGenreChange = vi.fn();
    const { container } = render(<BenchmarkPanel {...base({ onGenreChange })} />);
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "dialogue" } });
    expect(container.textContent).toContain("⚙️ 手动体裁");
    // 再选回 auto.genre（main）→ next === auto.genre，走 else-if 把 override 清掉
    fireEvent.change(select, { target: { value: "main" } });
    expect(onGenreChange).toHaveBeenCalledWith("main");
    expect(select.value).toBe("main");
    expect(container.textContent).toContain("🤖 自动识别");
    expect(container.textContent).not.toContain("⚙️ 手动体裁");
  });

  it("「回到自动」按钮：清 override、体裁按 auto 重切并上抛 null 给引擎", () => {
    const onGenreChange = vi.fn();
    const { container, getByText, queryByText } = render(
      <BenchmarkPanel {...base({ onGenreChange })} />,
    );
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "dialogue" } });
    expect(getByText("回到自动")).toBeTruthy();
    fireEvent.click(getByText("回到自动"));
    expect(onGenreChange).toHaveBeenLastCalledWith(null);
    expect(select.value).toBe("main");
    expect(container.textContent).toContain("🤖 自动识别");
    expect(container.textContent).not.toContain("⚙️ 手动体裁");
    // override 解除后「回到自动」按钮不再渲染
    expect(queryByText("回到自动")).toBeNull();
  });

  it("未传可选的 onGenreChange：切体裁与「回到自动」照常工作且不抛错", () => {
    const { container, getByText } = render(
      <BenchmarkPanel {...base({ onGenreChange: undefined })} />,
    );
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "dialogue" } });
    expect(select.value).toBe("dialogue");
    expect(container.textContent).toContain("⚙️ 手动体裁");
    // 回到自动走 onGenreChange?.(null) 可选链：缺省时安全跳过
    fireEvent.click(getByText("回到自动"));
    expect(select.value).toBe("main");
    expect(container.textContent).toContain("🤖 自动识别");
  });

  it("手动切到人写对照：引擎上抛 humanHand（该体裁不在自动识别输出里，必为 override）", () => {
    const onGenreChange = vi.fn();
    const { container } = render(<BenchmarkPanel {...base({ onGenreChange })} />);
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "humanHand" } });
    expect(onGenreChange).toHaveBeenCalledWith("humanHand");
    expect(container.textContent).toContain("⚙️ 手动体裁");
    expect(container.textContent).toContain("回到三分自动识别");
  });

  it("疑似纯人写原稿快捷按钮：点击把引擎体裁切到人写对照", () => {
    const onGenreChange = vi.fn();
    const { container, getByText, queryByText } = render(
      <BenchmarkPanel {...base({ output: NARR_TEXT, onGenreChange })} />,
    );
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("narrative"); // 自动识别命中叙事（rule 3）
    fireEvent.click(getByText("🚩 疑似纯人写原稿 → 引擎保留作者结构"));
    // 上抛 humanHand：只影响引擎行为（保留作者结构），不做任何分数换算
    expect(onGenreChange).toHaveBeenLastCalledWith("humanHand");
    expect(select.value).toBe("humanHand");
    expect(container.textContent).toContain("⚙️ 手动体裁");
    expect(queryByText(/疑似纯人写原稿/)).toBeNull(); // 切走后快捷按钮消失
    expect(getByText(/回到三分自动识别/)).toBeTruthy(); // 换成「回到三分」按钮
  });

  it("朱雀送检行：手动分数上抛；回填只记录、不显示过检标记", () => {
    const onManualScore = vi.fn();
    const p = base({ onManualScore });
    const { container, rerender } = render(<BenchmarkPanel {...p} />);
    const input = container.querySelector('input[type="number"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "28" } });
    expect(onManualScore).toHaveBeenCalledWith("28");
    rerender(<BenchmarkPanel {...base({ onManualScore, zhuqueManualScore: "28" })} />);
    expect(container.textContent).toContain("朱雀回填：28 分（仅记录）");
    rerender(<BenchmarkPanel {...base({ onManualScore, zhuqueManualScore: "65" })} />);
    expect(container.textContent).toContain("朱雀回填：65 分（仅记录）");
  });

  it("朱雀送检按钮：复制去味文本、打开官方送检页并上抛提示语", () => {
    const onNote = vi.fn();
    // 用可断言的桩替换 clipboard 与 window.open，避免真实打开浏览器页
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const { getByText } = render(<BenchmarkPanel {...base({ onNote })} />);
    fireEvent.click(getByText("🔍 朱雀送检（免费网页版）"));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(EXPO_TEXT);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(
      "https://matrix.tencent.com/ai-detect/ai_gen_txt/",
      "_blank",
    );
    expect(onNote).toHaveBeenCalledTimes(1);
    expect(onNote).toHaveBeenCalledWith(
      "已复制去味文本并打开朱雀检测页——粘贴检测后，在下方填入朱雀分",
    );
    openSpy.mockRestore();
  });

  it("API 与检测器都未启用时显示免费路径提示", () => {
    const { container } = render(<BenchmarkPanel {...base()} />);
    expect(container.textContent).toContain("对标检测两条路径");
  });

  /* ---- 本地套话指数 vs 外部通道分的分歧横幅（2026-09-22 外评证据） ---- */

  it("本地分低报：渲染 severe 横幅，点名通道并写明别看降幅", () => {
    // 本地 20（低分区）/ 评判 85 → gap 65，实测形态与「政务报告 本地 2 / 外部 90」同类
    const { container } = render(<BenchmarkPanel {...base({ judgeScore: 85 })} />);
    expect(container.textContent).toContain("本地套话指数 20");
    expect(container.textContent).toContain("LLM 评判 85");
    expect(container.textContent).toContain("降幅");
  });

  it("分歧不到门槛就不渲染横幅（本地 20 / 评判 25，差 5）", () => {
    const { container } = render(<BenchmarkPanel {...base({ judgeScore: 25 })} />);
    expect(container.textContent).not.toContain("两把尺分歧");
    expect(container.textContent).not.toContain("低报");
  });

  it("朱雀手动回填的高分同样触发，且文案点名朱雀官方分", () => {
    const { container } = render(<BenchmarkPanel {...base({ zhuqueManualScore: "90" })} />);
    expect(container.textContent).toContain("朱雀官方分 90");
  });

  it("多通道同时分歧：取 severe 里 gap 最大的那条", () => {
    const { container } = render(
      <BenchmarkPanel {...base({ judgeScore: 85, detectorScore: 75 })} />,
    );
    expect(container.textContent).toContain("LLM 评判 85");
    expect(container.textContent).not.toContain("外部检测器 75");
  });

  it("分歧在低分区之外（本地 40 / 评判 90）：warn 级黄色横幅，文案不扣「低分区」帽子", () => {
    // local 40 > AI_SCORE_HUMAN_MAX(27)，gap 50 ≥30、外部 90 ≥60 → warn 而非 severe
    const { container, getByText } = render(
      <BenchmarkPanel {...base({ after: { ...after, score: 40 }, judgeScore: 90 })} />,
    );
    expect(container.textContent).toContain("两把尺分歧 50 分（本地套话指数 40 / LLM 评判 90）");
    expect(container.textContent).not.toContain("（低分区）");
    // warn 用黄色底（rgba(250,204,21,0.1)），不是 severe 的红色底
    const row = getByText(/两把尺分歧/).closest(".bench-row") as HTMLElement;
    const style = (row.getAttribute("style") ?? "").replace(/\s/g, "");
    expect(style).toContain("rgba(250,204,21,0.1)");
  });
});
