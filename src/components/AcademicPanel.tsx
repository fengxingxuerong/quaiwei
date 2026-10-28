import type { AcademicAudit } from "../engine/academic-check";

/**
 * 学术自检面板（v0.9.81）。
 *
 * 它判的是**能不能投**，不判论证。面板自己不碰稿子：阻断项列出来，
 * 要不要改、怎么改由人拍板——机器判不了的（论证是否成立、结论是否过头）也写在面板里，
 * 免得 READY 被当成"审稿人会收"。
 */
export function AcademicPanel({
  audit,
  mode,
  onClose,
  onRun,
}: {
  audit: AcademicAudit;
  /** 这轮比的是什么：引擎自己改的，还是拿现成产出对比 */
  mode: string;
  onClose: () => void;
  /** 去味：阻断项多半是"还没跑过 / 跑坏了"，最自然的下一步是重跑一遍 */
  onRun: () => void;
}) {
  const blocked = audit.verdict === "blocked";
  const tone = blocked ? "#ff5d6c" : "#4fd1c5";

  const rowStyle = { justifyContent: "flex-start" as const, flexWrap: "wrap" as const, gap: 6 };

  return (
    <div className="bench">
      <div className="bench-head">
        学术自检（本地 路 只判能不能投，不判论证）
        <button className="ghost sm" style={{ marginLeft: 10 }} onClick={onClose}>
          收起
        </button>
      </div>

      <div className="bench-row" style={{ justifyContent: "flex-start" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: tone }}>
          {blocked
            ? `NOT READY TO SUBMIT（${audit.blockers.length} 个阻断项）`
            : "READY（机器没看见阻断项）"}
        </span>
      </div>

      <div className="bench-row" style={{ justifyContent: "flex-start" }}>
        <span style={{ color: "var(--muted)", fontSize: 11 }}>
          {mode} · 原文 {audit.stats.charsIn} 字 → 待检 {audit.stats.charsOut} 字 · 可校验引用键{" "}
          {audit.stats.citeKeys} 个 · 结构违规 {audit.stats.structureIssues} 处
        </span>
      </div>

      <div className="bench-row" style={rowStyle}>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>阻断项：</span>
        {audit.blockers.length === 0 ? (
          <span style={{ fontSize: 12, color: "#8a98b5" }}>无</span>
        ) : (
          audit.blockers.map((b, i) => (
            <span
              key={`${i}-${b.slice(0, 12)}`}
              style={{
                fontSize: 11,
                color: "#ff5d6c",
                border: "1px solid rgba(255,93,108,0.35)",
                borderRadius: 10,
                padding: "1px 8px",
              }}
            >
              {b}
            </span>
          ))
        )}
      </div>

      <div className="bench-row" style={rowStyle}>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>提醒（不阻断）：</span>
        {audit.warnings.length === 0 ? (
          <span style={{ fontSize: 12, color: "#8a98b5" }}>无</span>
        ) : (
          audit.warnings.map((w, i) => (
            <span
              key={`${i}-${w.slice(0, 12)}`}
              style={{
                fontSize: 11,
                color: "#ffb454",
                border: "1px solid rgba(255,180,84,0.35)",
                borderRadius: 10,
                padding: "1px 8px",
              }}
            >
              {w}
            </span>
          ))
        )}
      </div>

      <div className="bench-row" style={rowStyle}>
        <span style={{ color: "var(--muted)", fontSize: 11 }}>
          这轮查了：{audit.checked.join(" · ")}
        </span>
      </div>

      <div className="bench-row" style={rowStyle}>
        <span style={{ color: "var(--muted)", fontSize: 11 }}>
          READY 不等于审稿人会收（论证是否成立机器判不了）；NOT READY 也不等于稿子差，
          等于「机器看见了必须人看一眼的改动」。
        </span>
        <button className="ghost sm" onClick={onRun}>
          重新去味再检
        </button>
      </div>
    </div>
  );
}
