import { useMemo, useRef, useState } from "react";
import { runHumanize, effectiveKeys, type ApiConfig } from "../api/llm";
import { downloadBlob, importFileToText, makeDatedName } from "../app-fileio";
import { makeZipBlob } from "../docx-io";
import type { LocalSettings } from "../store";

type Genre = "main" | "narrative" | "dialogue" | "humanHand";
type Status = "pending" | "reading" | "running" | "done" | "error";

interface Item {
  id: number;
  file: File;
  name: string;
  input: string;
  output: string;
  before: number;
  after: number;
  status: Status;
  error?: string;
}

interface BatchModalProps {
  files: File[];
  api: ApiConfig;
  intensity: number;
  zhuqueMode: boolean;
  genre?: Genre;
  local: LocalSettings;
  onClose: () => void;
  onOpen: (input: string, output: string, name: string) => void;
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, "") || "未命名";
}

/**
 * 批量面板：多选文件后逐个走本地引擎（离线、零成本）。
 *
 * 刻意不接 LLM：批量 × 深度闭环会变成几十次付费调用，耗时与账单都不可控；
 * 需要 LLM 的用户走 CLI `--api`，那里有 --max-calls / --jobs 预算参数。
 */
export function BatchModal({
  files,
  api,
  intensity,
  zhuqueMode,
  genre,
  local,
  onClose,
  onOpen,
}: BatchModalProps) {
  const initial = useMemo<Item[]>(
    () =>
      files.map((file, i) => ({
        id: i,
        file,
        name: file.name,
        input: "",
        output: "",
        before: 0,
        after: 0,
        status: "pending" as Status,
      })),
    [files],
  );
  const [items, setItems] = useState<Item[]>(initial);
  const [running, setRunning] = useState(false);
  const [useLlm, setUseLlm] = useState(false);
  const [note, setNote] = useState("");
  /**
   * 停止请求（v0.9.64）。用 ref 而不是 state：`runAll` 是跑在旧闭包里的长循环，
   * 读 state 只会读到点击那一刻的值。粒度是「每篇之间」——当前这篇跑完才停，
   * 已完成的行不留半截结果，未开始的行仍是「等待」，再点一次「开始处理」即可续跑。
   */
  const stopRef = useRef(false);
  const [stopping, setStopping] = useState(false);
  const canUseLlm = api.enabled && effectiveKeys(api).length > 0;

  const update = (id: number, patch: Partial<Item>) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));

  function requestStop() {
    stopRef.current = true;
    setStopping(true);
    setNote("已请求停止：当前这篇跑完后停下，已完成的结果保留。");
  }

  async function runAll(onlyIds?: number[], force = false) {
    if (running) return;
    stopRef.current = false;
    setStopping(false);
    setRunning(true);
    setNote(
      useLlm && canUseLlm
        ? "批量使用当前 LLM 设置：每篇受 maxApiCalls 限制，可能较慢并产生费用；失败会自动回退本地引擎。"
        : "批量只走本地引擎（离线、零成本）；需要 LLM 深度模式可勾选上方选项，或使用 CLI --api。",
    );
    const cfg: ApiConfig = useLlm && canUseLlm ? api : { ...api, enabled: false };
    /** 停止时还剩多少篇没跑（只数后面还需要跑的；把已完成的重复计入会让文案虚高） */
    let stoppedRemaining = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (stopRef.current) {
        stoppedRemaining = items.slice(i).filter((x) => force || x.status !== "done").length;
        break; // 每篇之间检查一次（循环跑在旧闭包里，只能这样读停止标志）
      }
      if (onlyIds && !onlyIds.includes(it.id)) continue;
      if (!force && !onlyIds && it.status === "done") continue;
      if (onlyIds && it.status !== "error") continue;
      update(it.id, { status: "reading", error: undefined });
      const res = await importFileToText(it.file);
      if (!res.text) {
        update(it.id, { status: "error", error: res.note });
        continue;
      }
      update(it.id, { status: "running", input: res.text });
      try {
        const r = await runHumanize(
          res.text,
          intensity,
          cfg,
          undefined,
          zhuqueMode,
          genre,
          local.bestOf ? { bestOf: true, candidates: local.candidates } : undefined,
        );
        update(it.id, {
          status: "done",
          output: r.text,
          before: r.before.score,
          after: r.after.score,
        });
      } catch (err: unknown) {
        update(it.id, {
          status: "error",
          error: `处理失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    setRunning(false);
    setStopping(false);
    if (stopRef.current) {
      setNote(
        `已停止：已完成的结果保留，后面还有 ${stoppedRemaining} 篇没跑（仍是「等待」）。再点「开始处理」可以接着跑。`,
      );
      return;
    }
    setNote("处理完成。可逐篇载入主界面，或打包下载全部 .txt。");
  }

  const done = items.filter((it) => it.status === "done");
  const failed = items.filter((it) => it.status === "error");

  function retryFailed() {
    if (!failed.length) return;
    void runAll(
      failed.map((it) => it.id),
      false,
    );
  }

  function rerunAll() {
    if (running) return;
    setItems((prev) =>
      prev.map((it) => ({
        ...it,
        status: "pending" as Status,
        error: undefined,
        output: "",
        input: "",
        before: 0,
        after: 0,
      })),
    );
    // 传 force：runAll 读到的还是本轮 render 的旧 items，不能靠状态刷新来跳过
    void runAll(undefined, true);
  }

  async function exportAll() {
    if (!done.length) return;
    const blob = await makeZipBlob(
      done.map((it, i) => ({
        // 批量里可能有同名文件；序号前缀保证 ZIP 条目唯一且顺序稳定
        name: `${String(i + 1).padStart(2, "0")}-${baseName(it.name)}.humanized.txt`,
        text: it.output,
      })),
    );
    downloadBlob(blob, makeDatedName("zip", "批量"));
  }

  return (
    <div className="modal-mask" onClick={running ? undefined : onClose}>
      <div
        className="modal batch-modal"
        role="dialog"
        aria-modal="true"
        aria-label="批量处理"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span>批量处理 · {items.length} 个文件</span>
          <button onClick={onClose} disabled={running} aria-label="关闭批量面板">
            ✕
          </button>
        </div>
        <p className="modal-tip">
          多选 .txt / .md / .docx 后逐个处理；默认走本地引擎，勾选下方选项可改用当前 LLM 设置。
          每个文件上限 2MB，原文件不会被修改，结果默认按<code>原名.humanized.txt</code> 导出。
        </p>
        {canUseLlm && (
          <label className="batch-llm">
            <input
              type="checkbox"
              checked={useLlm}
              onChange={(e) => setUseLlm(e.target.checked)}
              disabled={running}
            />
            使用当前 LLM 设置（慢、可能计费；每篇受 maxApiCalls 限制，失败自动回退本地）
          </label>
        )}

        <div className="batch-actions">
          <button className="primary" onClick={() => void runAll()} disabled={running}>
            {running ? "处理中…" : "开始处理"}
          </button>
          {running && (
            <button className="ghost" onClick={requestStop} disabled={stopping}>
              {stopping ? "正在停止…" : "停止"}
            </button>
          )}
          <button
            className="ghost"
            onClick={() => void exportAll()}
            disabled={!done.length || running}
          >
            打包下载（{done.length}）
          </button>
          {failed.length > 0 && (
            <button className="ghost" onClick={retryFailed} disabled={running}>
              重试失败（{failed.length}）
            </button>
          )}
          {(done.length > 0 || failed.length > 0) && (
            <button className="ghost" onClick={rerunAll} disabled={running}>
              全部重跑
            </button>
          )}
          {failed.length > 0 && <span className="batch-fail">失败 {failed.length}</span>}
        </div>

        <div className="batch-list">
          {items.map((it) => (
            <div className={`batch-row batch-${it.status}`} key={it.id}>
              <div className="batch-name" title={it.name}>
                {it.name}
              </div>
              <div className="batch-status">
                {it.status === "pending" && "等待"}
                {it.status === "reading" && "读取中"}
                {it.status === "running" && "去味中"}
                {it.status === "done" && `${it.before} → ${it.after}`}
                {it.status === "error" && (it.error || "失败")}
              </div>
              <div className="batch-row-actions">
                {it.status === "done" && (
                  <>
                    <button
                      className="ghost sm"
                      onClick={() => onOpen(it.input, it.output, it.name)}
                    >
                      载入
                    </button>
                    <button
                      className="ghost sm"
                      onClick={() =>
                        downloadBlob(
                          new Blob([it.output], { type: "text/plain;charset=utf-8" }),
                          `${baseName(it.name)}.humanized.txt`,
                        )
                      }
                    >
                      下载
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {note && <div className="note">{note}</div>}
      </div>
    </div>
  );
}
