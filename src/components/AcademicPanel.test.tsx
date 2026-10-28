// @vitest-environment happy-dom
/**
 * AcademicPanel：学术自检面板的呈现契约。
 *
 * 守两件事：判定必须一眼看见（READY / NOT READY + 阻断项），
 * 以及"READY 不等于审稿人会收"这句话不能丢——丢了面板就在替用户打包票。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { AcademicPanel } from "./AcademicPanel";
import { academicAudit } from "../engine/academic-check";

// 同一个文件里多次 render：不清理会让后一个用例撞上前一个用例留下的「收起」按钮
afterEach(() => cleanup());

const PAPER = "本文在 3 个数据集上做了消融实验，准确率提升 4.2 个百分点~\\cite{wang2024}。";

describe("AcademicPanel", () => {
  it("有阻断项时亮红字结论，并把每一条都列出来", () => {
    const audit = academicAudit(PAPER, "我们在多个数据集上做了实验，效果有明显提升。");
    const { container, getByText } = render(
      <AcademicPanel audit={audit} mode="审现成产出" onClose={() => {}} onRun={() => {}} />,
    );
    expect(getByText(/NOT READY TO SUBMIT/)).toBeTruthy();
    expect(container.textContent).toContain("wang2024");
  });

  it("通过时明写 READY，也照样带上「不等于审稿人会收」", () => {
    const audit = academicAudit(PAPER, PAPER);
    const { container } = render(
      <AcademicPanel audit={audit} mode="审现成产出" onClose={() => {}} onRun={() => {}} />,
    );
    expect(container.textContent).toContain("READY");
    expect(container.textContent).toContain("不等于审稿人会收");
  });

  it("点「收起」与「重新去味再检」分别回调，面板自己不关自己", () => {
    const audit = academicAudit(PAPER, PAPER);
    const onClose = vi.fn();
    const onRun = vi.fn();
    const { getByText } = render(
      <AcademicPanel audit={audit} mode="审现成产出" onClose={onClose} onRun={onRun} />,
    );
    fireEvent.click(getByText("收起"));
    fireEvent.click(getByText("重新去味再检"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("把「这轮查了什么」写出来（空查与查过都不许含糊）", () => {
    const audit = academicAudit(PAPER, PAPER);
    const { container } = render(
      <AcademicPanel audit={audit} mode="审现成产出" onClose={() => {}} onRun={() => {}} />,
    );
    expect(container.textContent).toContain("这轮查了");
    expect(container.textContent).toContain("引用");
  });
});
