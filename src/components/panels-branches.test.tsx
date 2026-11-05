// @vitest-environment happy-dom
/**
 * ZhuquePanel 语义权重滑块（v0.9.16 长尾清扫），
 * 以及 ErrorBoundary 兜底分支补测（重载出口点击 / 非 Error 抛出回退文案 /
 * componentDidCatch 日志断言——components.test.tsx 之外的盲区）。
 * v0.9.83：BenchmarkPanel 分档建议文案随标定子系统移除，对应 describe 一并摘除。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { ZhuquePanel } from "./ZhuquePanel";
import { ErrorBoundary } from "./ErrorBoundary";
import { detectZhuque } from "../engine/zhuque";

afterEach(() => cleanup());

const EXPO_TEXT =
  "值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。从长远来看，建立完善的监管体系，推动可持续发展，具有十分重要的意义。";

describe("ZhuquePanel 语义权重滑块", () => {
  function zqProps(overrides: Partial<Parameters<typeof ZhuquePanel>[0]> = {}) {
    return {
      text: EXPO_TEXT,
      rep: detectZhuque(EXPO_TEXT),
      calib: { a: 1, b: 0, n: 0, points: [] },
      paste: "",
      msg: "",
      showFeatures: false,
      sem: null,
      semLoading: false,
      weight: 0.8,
      canRunSemantic: false,
      onPaste: vi.fn(),
      onSaveCalib: vi.fn(),
      onClearCalib: vi.fn(),
      onCopySubmit: vi.fn(),
      onOpenOfficial: vi.fn(),
      onOpenLab: vi.fn(),
      onToggleFeatures: vi.fn(),
      onRunSemantic: vi.fn(),
      onWeight: vi.fn(),
      ...overrides,
    } as Parameters<typeof ZhuquePanel>[0];
  }

  it("拖动语义权重滑块触发 onWeight 回调", () => {
    const onWeight = vi.fn();
    const { container } = render(<ZhuquePanel {...zqProps({ onWeight })} />);
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider).toBeTruthy();
    fireEvent.change(slider, { target: { value: "0.5" } });
    expect(onWeight).toHaveBeenCalledWith(0.5);
  });

  it("权重滑块回显当前值", () => {
    const { container } = render(<ZhuquePanel {...zqProps({ weight: 0.8 })} />);
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider.value).toBe("0.8");
  });
});

describe("ErrorBoundary 兜底分支（重载出口 / 非 Error 抛出）", () => {
  // React 会把预期错误打到 console.error，静默之；同时借它断言 componentDidCatch 日志
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("抛出无 message 的非 Error 值：回退 UI 显示 String(error) 而非 undefined", () => {
    function BoomString(): never {
      throw "裸字符串炸了";
    }
    const { getByText, queryByText } = render(
      <ErrorBoundary>
        <BoomString />
      </ErrorBoundary>,
    );
    expect(getByText("界面出了点问题")).toBeTruthy();
    expect(getByText("裸字符串炸了")).toBeTruthy();
    expect(queryByText(/undefined/)).toBeNull();
    expect(getByText("重载应用")).toBeTruthy();
  });

  it("点「重载应用」触发 location.reload", () => {
    function Boom(): never {
      throw new Error("渲染层炸了");
    }
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    try {
      const { getByText } = render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
      expect(getByText("渲染层炸了")).toBeTruthy();
      fireEvent.click(getByText("重载应用"));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      reload.mockRestore();
    }
  });

  it("componentDidCatch 把错误与组件栈打到 console.error", () => {
    function Boom(): never {
      throw new Error("带日志的错误");
    }
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const hit = errorSpy.mock.calls.find((c: unknown[]) => c[0] === "[QuAiWei] 渲染层异常:");
    expect(hit).toBeTruthy();
    expect((hit![1] as Error).message).toBe("带日志的错误");
    expect(hit![2]).toBeDefined(); // React 传入的组件栈 info
  });
});
