// @vitest-environment happy-dom
/**
 * ReviewPanel 渲染级测试：痕迹地图只做只读展示，不能偷偷具备改写能力。
 *
 * 断言纪律：判串写死为独立常量，不从 `review.ts` 的 ADVICE 表反查——
 * 否则删掉某条建议会连带删掉对它的检查。
 *
 * 竞品吸收（二）增补：面板兼做「输入体检」，但仍不持有稿子——
 * 清洗动作只经 onClean 回调把文本交还调用方。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { ReviewPanel } from "./ReviewPanel";
import { reviewText } from "../engine/review";

afterEach(() => cleanup());

const AI_TEXT =
  "综上所述，企业需要构建高效协同的组织机制，这是提升核心竞争力的关键所在。" +
  "首先，数字化转型的深入推进赋能了业务协同能力；其次，精细化运营管理优化了资源配置效率。";

const HUMAN_TEXT =
  "周三下午的评审会开了三个小时，最后没结论。老张把需求文档改了第五版，前端还是没接。" +
  "我记得刚入职那会儿，测试环境和生产就分不清。";

/** 三类残渣各带一点：隐形字符 1 + 聊天残渣 2 + 重复标点 1 */
const DIRTY_TEXT =
  "以下是改写后的版本：\n" + "甲\u200B乙好。。\n" + "希望这对你有帮助。\n" + "正文。";

const renderPanel = (text: string, onClean = vi.fn(), onClose = vi.fn(), onRun = vi.fn()) =>
  render(
    <ReviewPanel
      report={reviewText(text)}
      text={text}
      onClose={onClose}
      onRun={onRun}
      onClean={onClean}
    />,
  );

describe("ReviewPanel", () => {
  it("把总句数、门槛句数与逐句命中都渲染出来", () => {
    const r = reviewText(AI_TEXT);
    expect(r.marked).toBeGreaterThan(0);
    const { getByText, container } = render(
      <ReviewPanel report={r} text={AI_TEXT} onClose={vi.fn()} onRun={vi.fn()} onClean={vi.fn()} />,
    );

    expect(getByText(/AI 味痕迹地图/)).toBeTruthy();
    expect(getByText(/只读 · 不改稿/)).toBeTruthy();
    expect(container.textContent).toContain(`共 ${r.total} 句`);
    expect(container.textContent).toContain(`达到痕迹门槛 ${r.marked} 句`);
    // 逐句序号与建议都得上屏
    expect(container.textContent).toContain(`第${r.marks[0].index}句`);
    expect(container.textContent).toContain("建议改");
    expect(container.textContent).toContain("→ ");
  });

  it("无痕迹时给的是限定语，不是「像人写」的承诺", () => {
    const r = reviewText(HUMAN_TEXT);
    expect(r.marked).toBe(0);
    const { container } = renderPanel(HUMAN_TEXT);
    expect(container.textContent).toContain("不代表一定像人写");
    expect(container.textContent).not.toMatch(/保证|一定通过|必定/);
  });

  it("收起与去味各自回调：去味前先收起地图", () => {
    const onClose = vi.fn();
    const onRun = vi.fn();
    const { getByText } = renderPanel(AI_TEXT, vi.fn(), onClose, onRun);

    fireEvent.click(getByText("收起"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRun).not.toHaveBeenCalled();

    fireEvent.click(getByText("去味"));
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("面板本身不改任何文本：渲染前后 review 报告字节不变", () => {
    const r = reviewText(AI_TEXT);
    const snapshot = JSON.stringify(r);
    render(
      <ReviewPanel report={r} text={AI_TEXT} onClose={vi.fn()} onRun={vi.fn()} onClean={vi.fn()} />,
    );
    expect(JSON.stringify(r)).toBe(snapshot);
  });

  it("输入体检：干净文本给出「未发现」结论，且没有清洗按钮", () => {
    const { container, queryByText } = renderPanel(HUMAN_TEXT);
    expect(container.textContent).toContain("输入体检");
    expect(container.textContent).toContain("未发现隐形字符 / 聊天残渣 / 重复标点");
    expect(queryByText(/一键清洗/)).toBeNull();
  });

  it("输入体检：三类残渣逐类计数并列出样本，点击清洗把清洗后的文本交还回调", () => {
    const onClean = vi.fn();
    const { getByText, container } = renderPanel(DIRTY_TEXT, onClean);

    expect(container.textContent).toContain("隐形字符 ×1");
    expect(container.textContent).toContain("聊天残渣 ×2");
    expect(container.textContent).toContain("重复标点 ×1");
    expect(container.textContent).toContain("零宽空格 U+200B");
    expect(container.textContent).toContain("AI 味痕迹地图");

    fireEvent.click(getByText(/一键清洗 4 处/));
    expect(onClean).toHaveBeenCalledTimes(1);
    const cleaned = onClean.mock.calls[0][0] as string;
    expect(cleaned).toBe("甲乙好。\n正文。");
    // 面板不落盘：原文本参数的内容不因点击而改变
    expect(DIRTY_TEXT).toContain("\u200B");
  });

  it("清洗按钮的文本仍来自最新入参（面板不缓存扫描结果）", () => {
    const onClean = vi.fn();
    const { rerender, getByText } = renderPanel(DIRTY_TEXT, onClean);
    const cleaner = "只。。有标点";
    rerender(
      <ReviewPanel
        report={reviewText(cleaner)}
        text={cleaner}
        onClose={vi.fn()}
        onRun={vi.fn()}
        onClean={onClean}
      />,
    );
    fireEvent.click(getByText(/一键清洗 1 处/));
    expect(onClean.mock.calls[0][0] as string).toBe("只。有标点");
  });
});
