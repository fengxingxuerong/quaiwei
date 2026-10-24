import { useMemo, useRef, useState } from "react";
import { runHumanize, effectiveKeys, type ApiConfig } from "../api/llm";
import { scoreViaDetector, type DetectorConfig } from "../api/detector";
import { downloadBlob, importFileToText, makeDatedName } from "../app-fileio";
import { makeZipBlob } from "../docx-io";
import type { DetectorPreset, LocalSettings } from "../store";

type Genre = "main" | "narrative" | "dialogue" | "humanHand";
type Status = "pending" | "reading" | "running" | "done" | "error";

/** v0.9.72：一篇稿子在**某一档**外部检测器上的读数 */
interface ExtScore {
  name: string;
  before: number | null;
  after: number | null;
  error?: string;
}

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
  /** v0.9.72：外部检测器逐档读数（没接检测器 / 未勾选时为空数组） */
  ext?: ExtScore[];
}

interface BatchModalProps {
  files: File[];
  api: ApiConfig;
  intensity: number;
  zhuqueMode: boolean;
  genre?: Genre;
  local: LocalSettings;
  /** v0.9.66：外部检测器配置（用户在设置里填的那个，可能与朱雀无关） */
  detector: DetectorConfig;
  /** v0.9.72：设置里存的多档预设——与当前档一起，可选几档参与本轮对比 */
  detectorPresets?: DetectorPreset[];
  onClose: () => void;
  onOpen: (input: string, output: string, name: string) => void;
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, "") || "未命名";
}

/**
 * v0.9.69：批量导出附带的报告清单（Markdown）。
 *
 * 为什么放 ZIP 里而不是只留在界面：批量跑完最容易丢的信息就是「这批到底改了多少、
 * 前后分是多少」。界面一关就没了，而交付/归档往往需要一张能贴进文档的表。
 *
 * 口径纪律：**本地分与外部检测器分分列两栏**，不合并——
 * 本地分是代理分（与去味引擎共用词表，必然变好看），外部分才是有意义的真值。
 * 没跑外部分时那一栏写「未送检」，而不是留空或填本地分冒充。
 */
export function buildBatchReport(
  rows: Item[],
  opts: { intensity: number; llm: boolean; detector: string },
): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
  const lines: string[] = [
    "# 批量去味报告",
    "",
    `- 生成时间：${stamp}`,
    `- 文件数：${rows.length}`,
    `- 去味强度：${Math.round(opts.intensity * 100)}%`,
    `- 引擎：${opts.llm ? "当前 LLM 设置（失败自动回退本地）" : "本地引擎（离线、零成本）"}`,
    `- 外部检测器：${opts.detector || "未启用"}`,
    "",
    "> 本地分是**代理分**（与去味引擎共用词表，前后对比才有意义）；",
    "> 外部检测器分是真值。两者口径不同，不要混为一谈。",
    "",
  ];

  // v0.9.72：多档时每档一列（表头用档位名）；单档仍是一列「外部 <名> 前 → 后」
  const extNames = Array.from(new Set(rows.flatMap((r) => (r.ext ?? []).map((x) => x.name))));
  if (extNames.length > 0) {
    const head = extNames.map((n) => `外部 ${n} 前 → 后`).join(" | ");
    const sep = extNames.map(() => "---").join("|");
    lines.push(`| # | 文件 | 本地 前 → 后 | ${head} | 备注 |`);
    lines.push(`|---|---|---|${sep}|---|`);
  } else {
    lines.push("| # | 文件 | 本地 前 → 后 | 备注 |");
    lines.push("|---|---|---|---|");
  }
  rows.forEach((r, i) => {
    const errors = (r.ext ?? []).filter((x) => x.error);
    const note = errors.length
      ? `外部检测失败：${errors.map((e) => `${e.name}=${(e.error ?? "").slice(0, 30)}`).join("；")}`
      : "";
    if (extNames.length > 0) {
      const cells = extNames.map((n) => {
        const hit = (r.ext ?? []).find((x) => x.name === n);
        if (!hit) return "未送检";
        if (typeof hit.before === "number" && typeof hit.after === "number") {
          return `${hit.before} → ${hit.after}`;
        }
        return "失败";
      });
      lines.push(
        `| ${i + 1} | ${r.name} | ${r.before} → ${r.after} | ${cells.join(" | ")} | ${note} |`,
      );
    } else {
      lines.push(`| ${i + 1} | ${r.name} | ${r.before} → ${r.after} | ${note} |`);
    }
  });

  const drop = rows.reduce((s, r) => s + (r.before - r.after), 0);
  lines.push("", `合计本地分下降：${drop} 分（${rows.length} 篇合计，仅作趋势参考）。`, "");
  return lines.join("\n");
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
  detector,
  detectorPresets = [],
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
  /** v0.9.66：外部检测器可用 = 用户开开关且填了 URL。每篇要送 2 次（原文+产出），必须显式勾选 */
  const canUseDetector = detector.enabled && detector.url.trim() !== "";
  const [useDetector, setUseDetector] = useState(false);
  /**
   * v0.9.72：参与本轮对比的档位（默认只勾当前档）。
   * 每档都是「原文 + 产出各送一次」，勾两档就是 4 次/篇——所以默认不勾、勾了也不静默加码。
   */
  const [picked, setPicked] = useState<Record<string, boolean>>(() => ({ __active: true }));
  const togglePick = (key: string) => setPicked((prev) => ({ ...prev, [key]: !prev[key] }));
  /** 勾选后真正要跑的档位；名字用于展示与报告表头 */
  const selectedDetectors: { name: string; cfg: DetectorConfig }[] = [];
  if (canUseDetector && picked.__active) {
    selectedDetectors.push({ name: "当前档", cfg: detector });
  }
  for (const [i, p] of detectorPresets.entries()) {
    if (!picked[`p${i}`]) continue;
    // 预设只存非敏感字段；凭证沿用当前档的 Key（各档 Key 不同时请用 CLI 逐档指定）
    selectedDetectors.push({
      name: p.name,
      cfg: { ...p.config, enabled: true, apiKey: detector.apiKey },
    });
  }

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
        // v0.9.66/72：外部检测器（可选）——逐档「原文 + 产出」各送一次，拿到真实的降幅。
        // 每篇 2 次/档会烧外部额度，所以默认不勾；某档失败只标该档，不影响出稿与其它档。
        if (useDetector && selectedDetectors.length > 0) {
          const rows: ExtScore[] = [];
          for (const d of selectedDetectors) {
            try {
              const before = await scoreViaDetector(res.text, d.cfg);
              const after = await scoreViaDetector(r.text, d.cfg);
              rows.push({ name: d.name, before, after });
            } catch (e) {
              rows.push({
                name: d.name,
                before: null,
                after: null,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }
          update(it.id, { ext: rows });
        }
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
    // v0.9.69：ZIP 里先放一份**报告清单**——批量跑完最容易丢的就是"这批到底改了什么、
    // 前后分多少"。正文之外给一张表，交付/归档时不用再回头对着界面截图。
    const report = buildBatchReport(done, {
      intensity,
      llm: useLlm && canUseLlm,
      detector: useDetector && canUseDetector ? detector.url : "",
    });
    const blob = await makeZipBlob([
      { name: "00-批量报告.md", text: report },
      ...done.map((it, i) => ({
        // 批量里可能有同名文件；序号前缀保证 ZIP 条目唯一且顺序稳定
        name: `${String(i + 1).padStart(2, "0")}-${baseName(it.name)}.humanized.txt`,
        text: it.output,
      })),
    ]);
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
        {canUseDetector && (
          <>
            <label className="batch-llm">
              <input
                type="checkbox"
                checked={useDetector}
                onChange={(e) => setUseDetector(e.target.checked)}
                disabled={running}
              />
              用外部检测器打前后分（每档每篇送检 <b>2 次</b>：原文 + 产出；会消耗外部额度）
            </label>
            {/* v0.9.72：多档对比——勾哪几档就逐档送检，报告里每档一列 */}
            {useDetector && (
              <div className="batch-detectors">
                <span className="batch-detectors-label">参与对比的档位：</span>
                <label>
                  <input
                    type="checkbox"
                    checked={!!picked.__active}
                    onChange={() => togglePick("__active")}
                    disabled={running}
                  />
                  当前档（{detector.url}）
                </label>
                {detectorPresets.map((p, i) => (
                  <label key={p.name}>
                    <input
                      type="checkbox"
                      checked={!!picked[`p${i}`]}
                      onChange={() => togglePick(`p${i}`)}
                      disabled={running}
                    />
                    {p.name}（{p.config.url}）
                  </label>
                ))}
                <span className="batch-detectors-hint">
                  每勾一档，每篇多 2 次外部调用；各档若用不同 Key，请改用 CLI 逐档指定。
                </span>
              </div>
            )}
          </>
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
                {it.status === "done" && (
                  <>
                    {`${it.before} → ${it.after}`}
                    {/* v0.9.66/72：外部检测器分数与本地代理分并排但不混为一谈；多档时逐档列出 */}
                    {(it.ext ?? []).map((x) =>
                      typeof x.before === "number" && typeof x.after === "number" ? (
                        <span className="batch-ext" key={x.name}>
                          {" "}
                          · 外部 {x.name} {x.before} → {x.after}
                        </span>
                      ) : (
                        <span className="batch-fail" key={x.name}>
                          {" "}
                          · 外部 {x.name} 检测失败
                        </span>
                      ),
                    )}
                  </>
                )}
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
