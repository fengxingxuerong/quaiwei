// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { BatchModal } from "./BatchModal";
import type { ApiConfig } from "../api/llm";
import type { DetectorConfig } from "../api/detector";

const { scoreViaDetectorMock, makeZipBlobMock } = vi.hoisted(() => ({
  // 假外部检测器：按字数给分（原文长、产出短 → 天然有降幅）
  scoreViaDetectorMock: vi.fn(async (text: string) => Math.min(100, text.length)),
  // 记下传给打包器的条目，用来断言"报告清单"确实进了 ZIP
  makeZipBlobMock: vi.fn(async (_files: { name: string; text: string }[]) => new Blob(["zip"])),
}));

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
vi.mock("../api/detector", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/detector")>()),
  scoreViaDetector: (text: string) => scoreViaDetectorMock(text),
}));
vi.mock("../docx-io", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../docx-io")>()),
  makeZipBlob: (files: { name: string; text: string }[]) => makeZipBlobMock(files),
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

/** 默认关闭：不干扰既有用例；要看检测器的那条用例自己开 `enabled: true` */
const DETECTOR_OFF = {
  enabled: false,
  url: "",
  apiKey: "",
  scorePath: "score",
  scale: "0-100",
} as DetectorConfig;
const DETECTOR_ON = { ...DETECTOR_OFF, enabled: true, url: "https://detector.example/score" };

describe("BatchModal", () => {
  beforeEach(() => {
    runHumanize.mockClear();
    runHumanize.mockImplementation(DEFAULT_RUN as never);
    scoreViaDetectorMock.mockClear();
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
        detector={DETECTOR_OFF}
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
        detector={DETECTOR_OFF}
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
        detector={DETECTOR_OFF}
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
        detector={DETECTOR_OFF}
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
        detector={DETECTOR_OFF}
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
        detector={DETECTOR_OFF}
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

  /**
   * v0.9.66：外部检测器接入批量面板。三条都锁住：
   *  · 没配检测器时不渲染开关（不给一个点了没用的选项）；
   *  · 勾选后**每篇送检 2 次**（原文 + 产出），不是只送产出；
   *  · 送检失败只标该行，不影响出稿。
   */
  it("外部检测器：勾选后每篇送检两次并显示前后分", async () => {
    const files = [
      new File(["甲"], "a.txt", { type: "text/plain" }),
      new File(["乙"], "b.txt", { type: "text/plain" }),
    ];
    const { getByLabelText, getByText, queryAllByText } = render(
      <BatchModal
        files={files}
        api={API}
        intensity={0.6}
        zhuqueMode={false}
        local={{ bestOf: false, candidates: 8 }}
        detector={DETECTOR_ON}
        onClose={() => {}}
        onOpen={() => {}}
      />,
    );

    fireEvent.click(getByLabelText(/用外部检测器打前后分/));
    fireEvent.click(getByText("开始处理"));

    await waitFor(() => expect(scoreViaDetectorMock).toHaveBeenCalledTimes(4)); // 2 篇 ×2
    expect(queryAllByText(/外部 当前档 \d+ → \d+/)).toHaveLength(2);
  });

  it("外部检测器失败只标该行，不中断出稿", async () => {
    scoreViaDetectorMock.mockRejectedValueOnce(new Error("配额耗尽"));
    const { getByLabelText, getByText, getAllByText, queryByText } = render(
      <BatchModal
        files={[new File(["甲"], "a.txt", { type: "text/plain" })]}
        api={API}
        intensity={0.6}
        zhuqueMode={false}
        local={{ bestOf: false, candidates: 8 }}
        detector={DETECTOR_ON}
        onClose={() => {}}
        onOpen={() => {}}
      />,
    );
    fireEvent.click(getByLabelText(/用外部检测器打前后分/));
    fireEvent.click(getByText("开始处理"));
    await waitFor(() => expect(getAllByText("10 → 2")).toHaveLength(1)); // 本地分照常出
    expect(queryByText(/外部 当前档 检测失败/)).toBeTruthy();
  });

  it("没配检测器时不渲染外部开关", () => {
    const { queryByLabelText } = render(
      <BatchModal
        files={[new File(["甲"], "a.txt", { type: "text/plain" })]}
        api={API}
        intensity={0.6}
        zhuqueMode={false}
        local={{ bestOf: false, candidates: 8 }}
        detector={DETECTOR_OFF}
        onClose={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(queryByLabelText(/用外部检测器打前后分/)).toBeNull();
  });

  /**
   * v0.9.69：打包下载的 ZIP 里要先放一份**报告清单**。
   * 批量跑完最容易丢的信息就是"这批改了多少、前后分多少"——界面一关就没了。
   */
  it("打包下载：ZIP 首条是 00-批量报告.md，且本地分与外部分分列", async () => {
    const files = [
      new File(["甲"], "a.txt", { type: "text/plain" }),
      new File(["乙"], "b.txt", { type: "text/plain" }),
    ];
    const { getByLabelText, getByText, getByRole } = render(
      <BatchModal
        files={files}
        api={API}
        intensity={0.9}
        zhuqueMode={false}
        local={{ bestOf: false, candidates: 8 }}
        detector={DETECTOR_ON}
        onClose={() => {}}
        onOpen={() => {}}
      />,
    );
    fireEvent.click(getByLabelText(/用外部检测器打前后分/));
    fireEvent.click(getByText("开始处理"));
    await waitFor(() => expect(scoreViaDetectorMock).toHaveBeenCalledTimes(4));
    fireEvent.click(getByRole("button", { name: /打包下载/ }));

    await waitFor(() => expect(makeZipBlobMock).toHaveBeenCalled());
    const entries = makeZipBlobMock.mock.calls[makeZipBlobMock.mock.calls.length - 1]?.[0] as {
      name: string;
      text: string;
    }[];
    expect(entries[0].name).toBe("00-批量报告.md");
    // 正文条目仍在，且带序号前缀
    expect(entries.slice(1).map((e) => e.name)).toEqual([
      "01-a.humanized.txt",
      "02-b.humanized.txt",
    ]);
    const report = entries[0].text;
    expect(report).toContain("# 批量去味报告");
    expect(report).toContain("去味强度：90%");
    expect(report).toContain("外部检测器：https://detector.example/score");
    expect(report).toMatch(/\| 1 \| a\.txt \| 10 → 2 \| \d+ → \d+ \|/); // 本地列与外部列都在
    expect(report).not.toContain("未送检"); // 这次跑了两篇，都有外部分
  });

  it("打包下载：没跑外部检测时报告只有本地列，外部分不冒充", async () => {
    const { getByText, getByRole } = render(
      <BatchModal
        files={[new File(["甲"], "a.txt", { type: "text/plain" })]}
        api={API}
        intensity={0.6}
        zhuqueMode={false}
        local={{ bestOf: false, candidates: 8 }}
        detector={DETECTOR_OFF}
        onClose={() => {}}
        onOpen={() => {}}
      />,
    );
    fireEvent.click(getByText("开始处理"));
    await waitFor(() => expect(runHumanize).toHaveBeenCalledTimes(1));
    fireEvent.click(getByRole("button", { name: /打包下载/ }));
    await waitFor(() => expect(makeZipBlobMock).toHaveBeenCalled());
    const report = (
      makeZipBlobMock.mock.calls[makeZipBlobMock.mock.calls.length - 1]?.[0] as { text: string }[]
    )[0].text;
    expect(report).toContain("外部检测器：未启用");
    expect(report).toMatch(/\| 1 \| a\.txt \| 10 → 2 \|/);
    expect(report).not.toMatch(/外部 .*前 → 后/); // 没送检就不出现外部列
  });

  /**
   * v0.9.72：多档对比——勾选预设后每档各送检一次，行内与报告都逐档列出。
   */
  it("多档对比：勾一档预设后，该档也参与送检并进报告表", async () => {
    const preset = {
      name: "自建 mock",
      config: {
        enabled: true,
        url: "https://mock.example/score",
        apiKey: "",
        scorePath: "score",
        scale: "0-100" as const,
      },
    };
    const { getByLabelText, getByText, getByRole, queryAllByText } = render(
      <BatchModal
        files={[new File(["甲"], "a.txt", { type: "text/plain" })]}
        api={API}
        intensity={0.9}
        zhuqueMode={false}
        local={{ bestOf: false, candidates: 8 }}
        detector={DETECTOR_ON}
        detectorPresets={[preset]}
        onClose={() => {}}
        onOpen={() => {}}
      />,
    );
    fireEvent.click(getByLabelText(/用外部检测器打前后分/));
    fireEvent.click(getByLabelText(/自建 mock/));
    fireEvent.click(getByText("开始处理"));

    // 两档 × (原文 + 产出) = 4 次
    await waitFor(() => expect(scoreViaDetectorMock).toHaveBeenCalledTimes(4));
    expect(queryAllByText(/外部 当前档 \d+ → \d+/)).toHaveLength(1);
    expect(queryAllByText(/外部 自建 mock \d+ → \d+/)).toHaveLength(1);

    fireEvent.click(getByRole("button", { name: /打包下载/ }));
    await waitFor(() => expect(makeZipBlobMock).toHaveBeenCalled());
    const report = (
      makeZipBlobMock.mock.calls[makeZipBlobMock.mock.calls.length - 1]?.[0] as { text: string }[]
    )[0].text;
    // 报告里每档一列
    expect(report).toContain("外部 当前档 前 → 后");
    expect(report).toContain("外部 自建 mock 前 → 后");
  });
});
