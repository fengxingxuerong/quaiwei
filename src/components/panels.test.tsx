// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { LocalDetectPanel } from "./LocalDetectPanel";
import { detectAI } from "../engine/detector";

const AI_TEXT = `值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。从长远来看，建立完善的监管框架，推动可持续发展，具有十分重要的意义。`;
const HUMAN_TEXT = `我家楼下那家早餐店开了快十年了。老板娘记得我不吃香菜，每次都是提前给我挑出来。有次我出差一个月没去，回来她问我："上哪儿发财去了？"我说出差，她笑："还以为你搬走了。"`;

afterEach(() => cleanup());

describe("LocalDetectPanel（本地 14 特征检测）", () => {
  const detectIn = detectAI(AI_TEXT);
  const detectOut = detectAI(HUMAN_TEXT);

  it("渲染原文/去味稿双徽章与降档对照", () => {
    const { getByText } = render(
      <LocalDetectPanel
        detectIn={detectIn}
        detectOut={detectOut}
        showFeatures={false}
        onToggleFeatures={() => {}}
      />,
    );
    expect(getByText("原文")).toBeTruthy();
    expect(getByText("去味稿")).toBeTruthy();
    expect(getByText("风险分差")).toBeTruthy();
  });

  it("展开特征明细时显示 14 维特征条", () => {
    const { getByText } = render(
      <LocalDetectPanel
        detectIn={detectIn}
        detectOut={detectOut}
        showFeatures
        onToggleFeatures={() => {}}
      />,
    );
    expect(getByText(/14 维特征/)).toBeTruthy();
    expect(getByText(/AI 套话密度/)).toBeTruthy();
  });

  it("「看特征明细」按钮触发回调", () => {
    const onToggle = vi.fn();
    const { getByText } = render(
      <LocalDetectPanel
        detectIn={detectIn}
        detectOut={detectOut}
        showFeatures={false}
        onToggleFeatures={onToggle}
      />,
    );
    fireEvent.click(getByText("看特征明细"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("短文本给出可信度提示", () => {
    const { getByText } = render(
      <LocalDetectPanel
        detectIn={detectAI("很短的句子。就这样。")}
        detectOut={detectAI("另一个很短的句子。也没别的了。")}
        showFeatures={false}
        onToggleFeatures={() => {}}
      />,
    );
    expect(getByText(/短文本/)).toBeTruthy();
  });
});
