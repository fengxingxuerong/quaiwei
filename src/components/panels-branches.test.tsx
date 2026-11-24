// @vitest-environment happy-dom
/**
 * ErrorBoundary 兜底分支补测。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

afterEach(() => cleanup());

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
