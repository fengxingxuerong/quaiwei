// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { BatchModal } from "./BatchModal";
import type { ApiConfig } from "../api/llm";

const DEFAULT_RUN = async (text: string, _intensity?: number, _cfg?: ApiConfig) => ({
  text: `改后-${text}`,
  before: { score: 10 },
  after: { score: 2 },
  usedApi: false,
  engine: "local" as const,
  degrade: [],
  note: "",
  roundScores: [],
});

const runHumanize = vi.fn(DEFAULT_RUN);

vi.mock("../api/llm", () => ({
  runHumanize: (...args: unknown[]) => runHumanize(...(args as [string, number, ApiConfig])),
  effectiveKeys: (cfg: { apiKey?: string; apiKeys?: string }) =>
    [cfg.apiKey, cfg.apiKeys].filter(Boolean).join("\n").split(/\s+/).filter(Boolean),
}));
vi.mock("../app-fileio", () => ({
  importFileToText: vi.fn(async (f: File) => ({ text: `原文-${f.name}`, name: f.name, note: "" })),
  downloadBlob: vi.fn(),
  makeDatedName: vi.fn(() => "去味-批量-test.zip"),
}));

const API = {
  enabled: true,
  baseUrl: "",
  apiKey: "",
  model: "",
  style: "plain",
} as ApiConfig;

describe("BatchModal", () => {
  beforeEach(() => {
    runHumanize.mockClear();
    runHumanize.mockImplementation(DEFAULT_RUN as never);
    cleanup();
  });

  it("多选文件逐个跑本地引擎，显示前后分并可载入主界面", async () => {
    const files = [
      new File(["甲"], "a.txt", { type: "text/plain" }),
      new File(["乙"], "b.md", { type: "text/plain" }),
    ];
    const onOpen = vi.fn();
    const { getByText, getAllByText } = render(
      <BatchModal
        files={files}
        api={API}
        intensity={0.6}
        zhuqueMode={false}
        local={{ bestOf: false, candidates: 8 }}
        onClose={() => {}}
        onOpen={onOpen}
      />,
    );

    fireEvent.click(getByText("开始处理"));
    await waitFor(() => expect(runHumanize).toHaveBeenCalledTimes(2));
    expect(await getAllByText("10 → 2")).toHaveLength(2);
    expect(getByText("a.txt")).toBeTruthy();
    expect(getByText("b.md")).toBeTruthy();

    fireEvent.click(getAllByText("载入")[0]);
    expect(onOpen).toHaveBeenCalledWith("原文-a.txt", "改后-原文-a.txt", "a.txt");
  });

  it("有 Key 时显示 LLM 选项，勾选后把 enabled 配置传给 runHumanize", async () => {
    const api = { ...API, apiKey: "sk-test" };
    const { getByText, getByLabelText } = render(
      <BatchModal
        files={[new File(["丙"], "c.txt", { type: "text/plain" })]}
        api={api}
        intensity={0.6}
        zhuqueMode={false}
        local={{ bestOf: false, candidates: 8 }}
        onClose={() => {}}
        onOpen={() => {}}
      />,
    );
    fireEvent.click(getByLabelText(/使用当前 LLM 设置/));
    fireEvent.click(getByText("开始处理"));
    await waitFor(() => expect(runHumanize).toHaveBeenCalledTimes(1));
    expect((runHumanize.mock.calls[0][2] as ApiConfig).enabled).toBe(true);
  });

  it("文件读取失败只标红该行，不中断后续文件", async () => {
    const { importFileToText } = await import("../app-fileio");
    vi.mocked(importFileToText).mockImplementationOnce(async (f: File) => ({
      text: "",
      name: f.name,
      note: "文件内容为空",
    }));
    const files = [
      new File([""], "bad.txt", { type: "text/plain" }),
      new File(["好"], "good.txt", { type: "text/plain" }),
    ];
    const { getByText, getAllByText } = render(
      <BatchModal
        files={files}
        api={API}
        intensity={0.6}
        zhuqueMode={false}
        local={{ bestOf: false, candidates: 8 }}
        onClose={() => {}}
        onOpen={() => {}}
      />,
    );
    fireEvent.click(getByText("开始处理"));
    await waitFor(() => expect(runHumanize).toHaveBeenCalledTimes(1));
    expect(getByText("文件内容为空")).toBeTruthy();
    expect(getAllByText("10 → 2")).toHaveLength(1);

    // 重试失败：第二次读取走默认成功实现，坏行恢复为 done
    fireEvent.click(getByText(/重试失败（1）/));
    await waitFor(() => expect(runHumanize).toHaveBeenCalledTimes(2));
    expect(getAllByText("10 → 2")).toHaveLength(2);
  });

  it("无 Key 时不渲染 LLM 开关（避免给出一个点了也没用的选项）", () => {
    const { queryByLabelText } = render(
      <BatchModal
        files={[new File(["甲"], "a.txt", { type: "text/plain" })]}
        api={API}
        intensity={0.6}
        zhuqueMode={false}
        local={{ bestOf: false, candidates: 8 }}
        onClose={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(queryByLabelText(/使用当前 LLM 设置/)).toBeNull();
  });

  it("全部重跑：已完成的篇目也重新处理一遍", async () => {
    const files = [
      new File(["甲"], "a.txt", { type: "text/plain" }),
      new File(["乙"], "b.txt", { type: "text/plain" }),
    ];
    const { getByText, getAllByText } = render(
      <BatchModal
        files={files}
        api={API}
        intensity={0.6}
        zhuqueMode={false}
        local={{ bestOf: false, candidates: 8 }}
        onClose={() => {}}
        onOpen={() => {}}
      />,
    );
    fireEvent.click(getByText("开始处理"));
    await waitFor(() => expect(runHumanize).toHaveBeenCalledTimes(2));
    fireEvent.click(getByText("全部重跑"));
    await waitFor(() => expect(runHumanize).toHaveBeenCalledTimes(4));
    expect(getAllByText("10 → 2")).toHaveLength(2);
  });

  /**
   * v0.9.64：批量面板此前**没有中断通路**——勾了 LLM 之后每篇受 maxApiCalls 约束，
   * 几十篇可能是小时级，而运行期间关闭按钮是 disabled、遮罩点击也被忽略，用户只能杀进程。
   * 停止粒度是「每篇之间」：当前这篇跑完才停，已完成的结果保留，未跑的仍是「等待」，可续跑。
   */
  it("停止：当前这篇跑完后停下，已完成保留，剩下的可续跑", async () => {
    const gates: Array<() => void> = [];
    runHumanize.mockImplementation(((text: string) => {
      return new Promise((resolve) => {
        gates.push(() =>
          resolve({
            text: `改后-${text}`,
            before: { score: 10 },
            after: { score: 2 },
            usedApi: false,
            engine: "local",
            degrade: [],
            note: "",
            roundScores: [],
          }),
        );
      });
    }) as never);

    const files = [
      new File(["甲"], "a.txt", { type: "text/plain" }),
      new File(["乙"], "b.txt", { type: "text/plain" }),
      new File(["丙"], "c.txt", { type: "text/plain" }),
    ];
    const { getByText, getAllByText } = render(
      <BatchModal
        files={files}
        api={API}
        intensity={0.6}
        zhuqueMode={false}
        local={{ bestOf: false, candidates: 8 }}
        onClose={() => {}}
        onOpen={() => {}}
      />,
    );

    fireEvent.click(getByText("开始处理"));
    await waitFor(() => expect(gates.length).toBe(1)); // 第一篇已开跑（挂起中）
    fireEvent.click(getByText("停止")); // 请求停止
    gates[0](); // 放行第一篇

    await waitFor(() => expect(getAllByText("10 → 2")).toHaveLength(1));
    expect(runHumanize).toHaveBeenCalledTimes(1); // 第二、三篇没有开跑
    expect(getAllByText("等待")).toHaveLength(2);
    expect(getByText(/已停止/)).toBeTruthy();
    expect(getByText(/还有 2 篇没跑/)).toBeTruthy();

    // 续跑：再点一次「开始处理」，剩下的两篇**串行**接着跑完
    fireEvent.click(getByText("开始处理"));
    await waitFor(() => expect(gates.length).toBe(2)); // 第二篇开跑
    gates[1](); // 放行第二篇，第三篇才会开始
    await waitFor(() => expect(gates.length).toBe(3));
    gates[2]();
    await waitFor(() => expect(getAllByText("10 → 2")).toHaveLength(3));
  });
});
