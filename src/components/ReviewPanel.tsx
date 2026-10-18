import { type ReviewReport } from "../engine/review";
import { scanInputJunk, cleanInputJunk, type JunkKindHits } from "../engine/input-hygiene";

/**
 * 审题面板（detector-only）——**只读**。它不持有任何改写能力，也不碰 input/output，
 * 存在的意义是让人先看清「哪几句露馅、为什么」，再决定要不要点「去味」。
 *
 * 起因（2026-10-17 开源同类对标）：`petergyang/no-ai-slop`（12.4k★）的 detect 模式
 * 是它三模式之一；本仓库此前只有「改完才知道改了什么」（ExplainPanel），缺这一步。
 *
 * 增补（2026-10-19 竞品吸收（二））：面板兼做「输入体检」——隐形字符/聊天残渣/
 * 重复标点的扫描与一键清洗（randytorres/humanizer autofix 的对应物）。
 * 清洗仍然不让面板碰稿子：它只把清洗后的文本交还给调用方。
 */
export function ReviewPanel({
  report,
  text,
  onClose,
  onRun,
  onClean,
}: {
  report: ReviewReport;
  /** 当前原文：只用于体检扫描，面板不改它 */
  text: string;
  onClose: () => void;
  /** 给一个直接进主流程的出口：看到问题后最常见的动作就是去味 */
  onRun: () => void;
  /** 一键清洗：把清洗后的文本交还调用方落盘（面板自己不写任何状态） */
  onClean: (cleaned: string) => void;
}) {
  const sevColor = (risk: number) => (risk >= 60 ? "#ff5d6c" : risk >= 45 ? "#ffb454" : "#8a98b5");
  const junk = scanInputJunk(text);
  const junkCats: Array<[string, JunkKindHits]> = [
    ["隐形字符", junk.invisible],
    ["聊天残渣", junk.chatbot],
    ["重复标点", junk.punct],
  ];

  return (
    <div className="bench">
      <div className="bench-head">
        AI 味痕迹地图（只读 · 不改稿）
        <button className="ghost sm" style={{ marginLeft: 10 }} onClick={onClose}>
          收起
        </button>
      </div>

      <div className="bench-row">
        <span>
          代理分 <b style={{ color: sevColor(report.probability) }}>{report.probability}</b> / 100 ·{" "}
          {report.levelText}
        </span>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>
          共 {report.total} 句，达到痕迹门槛 {report.marked} 句
        </span>
      </div>
      <div className="bench-row" style={{ justifyContent: "flex-start" }}>
        <span style={{ color: "var(--muted)", fontSize: 11 }}>
          AI 参与比例 ≈ {report.editedRatio}%（达门槛句的字符占比，本地估计）· 样本置信度：
          {report.confidence.text}
        </span>
      </div>
      <div className="bench-row" style={{ justifyContent: "flex-start" }}>
        <span style={{ color: "var(--muted)", fontSize: 11 }}>
          本地启发式代理分，不是任何检测器的官方分——只有同一篇的前后对比有意义
        </span>
      </div>

      <div className="bench-row" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>输入体检：</span>
        {junk.total === 0 ? (
          <span style={{ fontSize: 12, color: "#8a98b5" }}>
            未发现隐形字符 / 聊天残渣 / 重复标点
          </span>
        ) : (
          <>
            {junkCats
              .filter(([, hits]) => hits.count > 0)
              .map(([name, hits]) => (
                <span
                  key={name}
                  style={{
                    fontSize: 11,
                    color: "#ffb454",
                    border: "1px solid rgba(255,180,84,0.35)",
                    borderRadius: 10,
                    padding: "1px 8px",
                  }}
                >
                  {name} ×{hits.count}
                </span>
              ))}
            <button className="ghost sm" onClick={() => onClean(cleanInputJunk(text).text)}>
              一键清洗 {junk.total} 处
            </button>
          </>
        )}
      </div>
      {junk.total > 0 && (
        <div
          className="bench-row"
          style={{
            justifyContent: "flex-start",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: 2,
          }}
        >
          {junkCats
            .flatMap(([, hits]) => hits.samples)
            .map((s, i) => (
              <span key={i} style={{ fontSize: 11, color: "var(--muted)" }}>
                · {s.label}「{s.snippet}」
              </span>
            ))}
          <span style={{ fontSize: 11, color: "var(--muted)" }}>
            只做机械清洗：删隐形字符、去独立成行的聊天包装语、收敛重复标点；正文里的同款词语不动。
          </span>
        </div>
      )}

      {report.summary.length > 0 && (
        <div className="bench-row" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>痕迹分布：</span>
          {report.summary.map(([k, v], i) => (
            <span
              key={i}
              style={{
                fontSize: 11,
                color: "var(--muted)",
                border: "1px solid rgba(120,160,255,0.25)",
                borderRadius: 10,
                padding: "1px 8px",
              }}
            >
              {k} ×{v}
            </span>
          ))}
        </div>
      )}

      {report.marks.length === 0 ? (
        <div className="bench-row" style={{ justifyContent: "flex-start" }}>
          <span style={{ fontSize: 12, color: "#3ddc97" }}>
            没有句子达到痕迹门槛——不代表一定像人写，只代表本地判据没抓到。
          </span>
        </div>
      ) : (
        <div className="diff-box" style={{ maxHeight: 320 }}>
          {report.marks.map((m) => (
            <div key={m.index} style={{ marginBottom: 10 }}>
              <div>
                <span style={{ color: sevColor(m.risk), fontSize: 12, marginRight: 6 }}>
                  第{m.index}句 · {m.risk} · {m.severityText}
                </span>
              </div>
              <div style={{ fontSize: 13 }}>{m.sentence}</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>
                命中：{m.reasons.join(" / ")}
              </div>
              {m.suggestions.map((s, k) => (
                <div key={k} style={{ fontSize: 11, color: "#8a98b5" }}>
                  → {s}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {report.warnings.map((w, k) => (
        <div className="bench-row" key={"w" + k} style={{ justifyContent: "flex-start" }}>
          <span style={{ color: "#ffb454", fontSize: 11 }}>· {w}</span>
        </div>
      ))}

      <div className="bench-row">
        <button className="primary sm" onClick={onRun}>
          去味
        </button>
        <span style={{ color: "var(--muted)", fontSize: 11 }}>
          先看清问题在哪，再决定改不改；点了才动你的稿
        </span>
      </div>
    </div>
  );
}
