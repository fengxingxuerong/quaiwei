/**
 * 趣AI味 · 对标评分面板：深度轮次分、LLM 评判、外部检测器、朱雀送检回填、
 * 以及本地代理分 → 官方朱雀分的标定预测（v3 四体裁分层制 18 点 OLS，
 * 见 docs/fingerprint-and-zhuque-calibration.md §3 + scripts/zhuque-calibration-v3.txt）。
 *
 * v3 更新（2026-08-26）：
 *  · 样本数从 v2 的 12 点 → v3 18 点（送官网新检 6 点 + v2 归档 12 点）
 *  · 各体裁 R² 普遍提升：论说 0.962→0.98（n=3→5）/ 叙事 0.998→0.99 / 对话 0.998→1.00（n=3→5）/ 人写 0.75→0.77
 *  · 论说参考线仍为 aiScore ≈ 10.4；叙事 ≈ 12.6；对话 ≈ 15.3；人写线斜率为负
 */
import { useState, useMemo, useEffect } from "react";
import { DEEP_TARGET_SCORE, type ApiConfig } from "../api/llm";
import type { DetectorConfig } from "../api/detector";
import type { ScoreBreakdown } from "../engine/humanize";
import {
  classifyGenre,
  GENRE_ZH,
  type AutoGenre,
  type GenreResult,
} from "../engine/classify-genre.ts";
import { CALIB, TRACK_ORDER, type CalibTrack, type CalibEntry } from "../engine/zhuque-calib";
import { pickConflict, scoreConflict, type ScoreConflict } from "../engine/score-conflict";

/** v3 徽章 & 建议（docs §3.7 规则 + 体裁联动 x40 提示 · v3 18 点 OLS 版） */
function predictAdvice(
  predPct: number,
  score: number | undefined,
  cur: Pick<CalibEntry, "satX" | "x40" | "x40Tag" | "humanWarn" | "advanced" | "label">,
) {
  const saturated =
    !cur.humanWarn && typeof score === "number" && cur.satX < 1e9 && score >= cur.satX;
  const pct = Math.max(0, Math.min(100, predPct));

  // 40% 只是存档公式上的参考刻度，不是官方过检线，更不是交付承诺。
  const referenceGap = pct - 40;

  // 建议行动卡：只给下一步，不承诺结果
  let recAction: string;
  if (cur.humanWarn) {
    recAction =
      "若确认是纯人写原稿：不建议再跑本地去味；如确需处理，强度 ≤0.48，只做轻微调整并真实送检复核。";
  } else if (pct <= 20) {
    recAction = "本地估计偏低。建议先用朱雀网页/API 实测一次再决定是否继续；不要仅凭这个预测交稿。";
  } else if (pct <= 40) {
    recAction = "本地估计中等偏低。建议真实送检一次；若要继续，可小幅提高强度并复查。";
  } else if (pct <= 60) {
    recAction = "本地估计中等。可优先处理结构（总分总/编号列举/段首雷同），再用真实检测器复核。";
  } else if (pct <= 80) {
    recAction = "本地估计偏高。可打散总分总、把“首先/其次/最后”改插叙、编号改散写，再送检。";
  } else {
    recAction = "本地估计很高。先清套话连接词，再做结构级改写；最终以官方检测为准。";
  }

  let icon = "🔴";
  let tip = "本地估计很高（非官方结论）";
  let tint = "rgba(255,93,108,0.12)";
  let border = "rgba(255,93,108,0.35)";
  let fg = "#ff5d6c";

  if (saturated || pct >= 98) {
    icon = "🔴";
    tip = saturated
      ? `本地估计已饱和（aiScore≥${cur.satX.toFixed(0)}）；官方分无法由本地分可靠推算`
      : "本地估计很高（非官方结论）";
  } else if (pct <= 20) {
    icon = "🔵";
    tip = `本地估计偏低（${cur.x40Tag}）；必须真实送检确认`;
    tint = "rgba(96,165,250,0.12)";
    border = "rgba(96,165,250,0.35)";
    fg = "#60a5fa";
  } else if (pct <= 40) {
    icon = "🟢";
    tip = `本地估计中等偏低（${cur.x40Tag}）；必须真实送检确认`;
    tint = "rgba(61,220,151,0.12)";
    border = "rgba(61,220,151,0.35)";
    fg = "#3ddc97";
  } else if (pct <= 60) {
    icon = "🟡";
    tip = `本地估计中等（${cur.x40Tag}）；最终以真实检测为准`;
    tint = "rgba(250,204,21,0.12)";
    border = "rgba(250,204,21,0.35)";
    fg = "#facc15";
  } else if (pct <= 80) {
    icon = "🟠";
    tip = "本地估计偏高；建议先处理结构再送检";
    tint = "rgba(249,115,22,0.12)";
    border = "rgba(249,115,22,0.35)";
    fg = "#fb923c";
  }

  // 副线/人写线：顶部打横幅提示
  const banner: string | null = cur.humanWarn
    ? "🚩 若确认是 100% 纯人写原稿：不建议再去味。存档样本里 H0 未处理=15%，去味后升到 17~19%，但这不是保证，最终请真实送检。"
    : cur.advanced
      ? "⚠️ 副线仅存档" + cur.label + "的拼接送检流程，显示的预测值不能用于交付件阈值判断"
      : null;

  // 2026-08-26 v3：高于/低于 40% 参考线的描述（仅参考，不表示已过检）
  const gapAbs = Math.abs(referenceGap).toFixed(1);
  const badge = {
    text:
      referenceGap > 0
        ? `⚠️ 高于 40% 参考线 ${gapAbs} pp`
        : referenceGap === 0
          ? "在 40% 参考线上（仅参考）"
          : `低于 40% 参考线 ${gapAbs} pp（仅参考）`,
    color:
      referenceGap <= 0
        ? "#8a98b5"
        : referenceGap <= 5
          ? "#facc15"
          : referenceGap <= 20
            ? "#fb923c"
            : "#ff5d6c",
  };

  // 进度条刻度：0 |-- 低 --| 40(参考线) |-- 高 --| 100
  const passRatio = 0.4; // 40% 参考线，不是过检线
  const ratio = pct / 100;
  const progressBg: React.CSSProperties = {
    position: "relative",
    width: "100%",
    height: 10,
    borderRadius: 999,
    background:
      "linear-gradient(90deg, #0b5e2f 0%, #22c55e 28%, #3ddc97 40%, #facc15 52%, #fb923c 75%, #ff5d6c 100%)",
    overflow: "hidden",
    marginTop: 4,
    marginBottom: 4,
  };
  const progressCursor: React.CSSProperties = {
    position: "absolute",
    top: -3,
    left: `calc(${ratio * 100}% - 7px)`,
    width: 14,
    height: 16,
    background: fg,
    border: "2px solid #fff",
    borderRadius: 4,
    transform: "rotate(45deg)",
    boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
  };
  const passTick: React.CSSProperties = {
    position: "absolute",
    top: -4,
    left: `calc(${passRatio * 100}% - 1px)`,
    width: 2,
    height: 18,
    background: "#ffffff",
    boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
  };

  return {
    icon,
    tip,
    tint,
    border,
    fg,
    banner,
    saturated,
    pct,
    badge,
    progressBg,
    progressCursor,
    passTick,
    recAction,
  };
}

interface BenchmarkPanelProps {
  output: string;
  after: ScoreBreakdown | null;
  roundScores: number[];
  judging: boolean;
  detecting: boolean;
  api: ApiConfig;
  detector: DetectorConfig;
  judgeScore: number | null;
  judgeCritique: string[];
  detectorScore: number | null;
  zhuqueManualScore: string;
  onJudge: () => void;
  onDetect: () => void;
  onManualScore: (v: string) => void;
  /** 用户手动切换体裁轨道时上抛；null = 回到自动识别 */
  onGenreChange?: (g: "main" | "narrative" | "dialogue" | "humanHand" | null) => void;
  onNote: (v: string) => void;
}

export function BenchmarkPanel({
  output,
  after,
  roundScores,
  judging,
  detecting,
  api,
  detector,
  judgeScore,
  judgeCritique,
  detectorScore,
  zhuqueManualScore,
  onJudge,
  onDetect,
  onManualScore,
  onGenreChange,
  onNote,
}: BenchmarkPanelProps) {
  const [track, setTrack] = useState<CalibTrack>("main");
  // 用户手动切过下拉 → 自动识别不再覆盖；点击「回到自动」按钮重置为 false
  const [trackOverrideByUser, setTrackOverrideByUser] = useState(false);

  // P6-C 自动体裁识别（memo：output 引用变化才重算）
  const auto: GenreResult | null = useMemo(() => {
    if (!output) return null;
    return classifyGenre(output);
  }, [output]);

  // 自动识别完成后，如果用户未手动 override，把轨道同步为识别结果
  useEffect(() => {
    if (!auto || trackOverrideByUser) return;
    const mapped = auto.genre as AutoGenre;
    setTrack((prev) => (prev === mapped ? prev : mapped));
  }, [auto, trackOverrideByUser]);

  // Hooks 规则：提前 return 必须放在所有 hook 之后，
  // 否则 output 从空变非空时 hook 数量变化会直接崩掉整棵树
  if (!output) return null;

  // 用户手动切换下拉 → 标记 override
  function onTrackChange(next: CalibTrack) {
    setTrack(next);
    // P7 引擎联动：把用户选的体裁上抛给 App → runHumanize，让引擎 knobs 真正跟随界面
    if (onGenreChange) {
      if (next === "human") onGenreChange("humanHand");
      else if (next === "main" || next === "narrative" || next === "dialogue") onGenreChange(next);
      else onGenreChange(null); // concat 副线不指定引擎体裁，走自动识别
    }
    // 仅当用户选的值和 auto 不一样才算 override；如果用户手动选的恰好等于 auto 就保持自动模式
    if (auto && next !== auto.genre) setTrackOverrideByUser(true);
    else if (auto && next === auto.genre) setTrackOverrideByUser(false);
    // 选副线 concat 或 human 时也标记 override（自动识别永远不会选这两条）
    if (next === "human" || next === "concat") setTrackOverrideByUser(true);
  }
  // 「回到自动识别」按钮：清 override 标记，并立即按当前 auto 重切轨道
  function resetToAuto() {
    setTrackOverrideByUser(false);
    if (auto) setTrack(auto.genre as AutoGenre);
    // 回到自动 → 清除引擎级 genre 强制，交还 classifyGenre 自动判定
    onGenreChange?.(null);
  }

  const score = after?.score;
  const cur = CALIB[track];

  /**
   * 本地代理分 vs 外部通道分的分歧（2026-09-22 外评证据，见 score-conflict.ts）。
   * 判据只认"外部比本地更像 AI"这一个方向：本地分低报会把用户骗到安全错觉里，
   * 反过来（本地偏严）只会让人多改一轮，没有安全后果。
   * 朱雀手动回填框是字符串，空的或填了非数字都不参与比较（scoreConflict 自己会拒 NaN）。
   */
  const conflict: ScoreConflict | null = pickConflict([
    scoreConflict(score, judgeScore, "judge"),
    scoreConflict(score, detectorScore, "detector"),
    scoreConflict(score, zhuqueManualScore.trim() ? Number(zhuqueManualScore) : null, "official"),
  ]);

  /** severe（本地分低报）用红，warn（只是分歧大）用黄——两级不能共用一种颜色，
   *  否则"本地分不成立"这个最重的结论会被当成普通提示划过去 */
  const conflictTint = conflict
    ? {
        flexWrap: "wrap" as const,
        borderRadius: 10,
        padding: "8px 10px",
        background: conflict.level === "severe" ? "rgba(255,93,108,0.12)" : "rgba(250,204,21,0.1)",
        border: `1px solid ${
          conflict.level === "severe" ? "rgba(255,93,108,0.4)" : "rgba(250,204,21,0.4)"
        }`,
      }
    : undefined;
  let predPct: number | null = null;
  let adv: ReturnType<typeof predictAdvice> | null = null;
  if (typeof score === "number" && !Number.isNaN(score)) {
    predPct = cur.a * score + cur.b;
    adv = predictAdvice(predPct, score, cur);
  }

  return (
    <div className="bench">
      <div className="bench-head">评分与外部验证（本地分为套话指数，非朱雀官方分）</div>
      {roundScores.length > 0 && (
        <div className="bench-row">
          <span>
            深度去味各轮 LLM 评分：
            <b>{roundScores.map((s) => (s < 0 ? "失败" : s)).join(" → ")}</b>（目标 ≤
            {api.deepTargetScore ?? DEEP_TARGET_SCORE}）
          </span>
        </div>
      )}
      <div className="bench-row">
        <span>
          本地套话指数（去味后）：<b>{after?.score}</b>
        </span>
        <button
          className="ghost sm"
          onClick={onJudge}
          disabled={!api.enabled || !api.apiKey || judging}
        >
          {judging ? "评判中…" : "用 LLM 评判"}
        </button>
        {judgeScore !== null && <span className="tag">LLM 评判：{judgeScore}</span>}
      </div>
      {judgeScore !== null && judgeCritique.length > 0 && (
        <div className="bench-row" style={{ flexWrap: "wrap" }}>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            残留痕迹：{judgeCritique.join("；")}
          </span>
        </div>
      )}
      {conflict && (
        <div className="bench-row" style={conflictTint}>
          <span
            style={{
              fontSize: 12,
              lineHeight: 1.6,
              color: conflict.level === "severe" ? "#ff5d6c" : "#facc15",
            }}
          >
            {conflict.message}
          </span>
        </div>
      )}
      <div className="bench-row">
        <button
          className="ghost sm"
          onClick={onDetect}
          disabled={!detector.enabled || !detector.url || detecting}
        >
          {detecting ? "检测中…" : "用外部检测器"}
        </button>
        {detectorScore !== null && <span className="tag">检测器：{detectorScore}</span>}
      </div>

      {/* ========= v3 四体裁分层 · 官方朱雀%预测（18 点 OLS） ========= */}
      {predPct !== null && adv && (
        <div
          className="bench-row"
          style={{
            flexWrap: "wrap",
            gap: 8,
            alignItems: "center",
            background: adv.tint,
            border: `1px solid ${adv.border}`,
            borderRadius: 10,
            padding: "8px 10px",
          }}
        >
          {adv.banner && (
            <div
              style={{
                width: "100%",
                fontSize: 12,
                fontWeight: 600,
                padding: "4px 6px",
                borderRadius: 6,
                marginBottom: 2,
                background: adv.banner.startsWith("🚩")
                  ? "rgba(251,146,60,0.12)"
                  : "rgba(148,163,184,0.12)",
                color: adv.banner.startsWith("🚩") ? "#fb923c" : "var(--muted)",
                border: adv.banner.startsWith("🚩")
                  ? "1px solid rgba(251,146,60,0.35)"
                  : "1px solid var(--border)",
              }}
            >
              {adv.banner}
            </div>
          )}
          <div style={{ width: "100%", fontSize: 11, color: "#facc15", lineHeight: 1.55 }}>
            实验性换算：官方凭证 0/18，公式未经凭证校准。仅用于同一篇稿子的前后趋势，
            <b>不能作为是否过检的依据</b>。
          </div>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            朱雀分趋势预测（18 点存档拟合 · 未标定）：
          </span>
          <b style={{ color: adv.fg }}>
            {adv.icon} {adv.pct.toFixed(1)}%
          </b>
          {/* 2026-08-26 v3：与 40% 参考线的差距徽章（仅参考） */}
          <span
            className="tag"
            style={{
              color: adv.badge.color,
              background: adv.badge.color + "20",
              border: `1px solid ${adv.badge.color}70`,
              fontSize: 12,
              fontWeight: 700,
              padding: "3px 8px",
              borderRadius: 999,
              whiteSpace: "nowrap",
            }}
          >
            {adv.badge.text}
          </span>
          <span style={{ fontSize: 12, color: adv.fg }}>{adv.tip}</span>
          {/* P6-C 自动识别徽章（放在下拉前，marginLeft:auto 推送到最右和下拉并排）*/}
          {auto && (
            <span
              className="tag"
              title={`自动识别详情 · 规则 R${auto.ruleHit}：对话dQ=${auto.features.dlgQuoteRatio.toFixed(3)}/dC=${auto.features.dlgColonRatio.toFixed(2)} · 论说分=${auto.features.expoScore.toFixed(2)} · 叙事past=${auto.features.narPastRatio.toFixed(3)}/scene=${auto.features.narSceneRatio.toFixed(3)} · 短句占比=${(auto.features.dlgShortTurn * 100).toFixed(0)}%`}
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 999,
                border: trackOverrideByUser
                  ? "1px solid rgba(250,204,21,0.55)"
                  : `1px solid ${auto.confidence >= 0.7 ? "rgba(34,197,94,0.5)" : "rgba(148,163,184,0.5)"}`,
                background: trackOverrideByUser
                  ? "rgba(250,204,21,0.1)"
                  : auto.confidence >= 0.7
                    ? "rgba(34,197,94,0.09)"
                    : "rgba(148,163,184,0.08)",
                color: trackOverrideByUser
                  ? "#facc15"
                  : auto.confidence >= 0.7
                    ? "#3ddc97"
                    : "var(--muted)",
                whiteSpace: "nowrap",
                marginLeft: 6,
              }}
            >
              {trackOverrideByUser ? "⚙️ 手动轨道" : "🤖 自动识别"}
              {!trackOverrideByUser &&
                `：${GENRE_ZH[auto.genre]} ${(auto.confidence * 100).toFixed(0)}%`}
              {trackOverrideByUser && auto && (
                <button
                  className="ghost sm"
                  onClick={resetToAuto}
                  title="根据当前文本，按自动识别结果切回轨道（v3 18点 OLS 公式）"
                  style={{
                    marginLeft: 6,
                    padding: "1px 8px",
                    fontSize: 11,
                    color: "#facc15",
                    border: "1px solid rgba(250,204,21,0.45)",
                    background: "rgba(250,204,21,0.08)",
                    borderRadius: 999,
                  }}
                >
                  回到自动
                </button>
              )}
            </span>
          )}
          <select
            value={track}
            onChange={(e) => onTrackChange(e.target.value as CalibTrack)}
            title="体裁切换：按当前文本实际体裁选对应的分层公式（docs §3.3 四体裁分线）。系统默认自动选择，手动切换后显示「手动轨道」可按按钮回到自动。"
            style={{
              marginLeft: 8,
              fontSize: 12,
              background: "rgba(8,12,22,0.6)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "4px 6px",
              outline: "none",
            }}
          >
            <optgroup label="体裁（v3 四分层 · 18 点 OLS · 2026-08-26）">
              {TRACK_ORDER.filter((k) => CALIB[k].group === "体裁(v3)").map((k) => (
                <option key={k} value={k}>
                  {CALIB[k].label}
                </option>
              ))}
            </optgroup>
            <optgroup label="高级（副线/存档）">
              {TRACK_ORDER.filter((k) => CALIB[k].group === "高级(副线)").map((k) => (
                <option key={k} value={k}>
                  {CALIB[k].label}
                </option>
              ))}
            </optgroup>
          </select>

          {/* 2026-08-26 v3：参考线进度条（40% 只是存档刻度，不是过检线） */}
          <div style={{ width: "100%" }}>
            <div style={adv.progressBg}>
              <div style={adv.passTick} title="40% 参考线（不是过检线）" />
              <div style={adv.progressCursor} title={`当前预测朱雀 ${adv.pct.toFixed(1)}%`} />
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 10,
                color: "var(--muted)",
                marginTop: 2,
              }}
            >
              <span>0%（低）</span>
              <span style={{ color: "#ffffff" }}>▌40% 参考线</span>
              <span>100%（高）</span>
            </div>
          </div>

          {/* 2026-08-26 v3：建议行动卡片 */}
          <div
            style={{
              width: "100%",
              fontSize: 12,
              color: "var(--text)",
              padding: "6px 10px",
              background: "rgba(15, 23, 42, 0.45)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              lineHeight: 1.55,
            }}
          >
            <span style={{ color: "var(--muted)", fontSize: 11 }}>
              💡 建议行动 · 基于当前预测分 {adv.pct.toFixed(1)}% 的下一次操作（非过检承诺）：
            </span>
            <div style={{ marginTop: 3 }}>{adv.recAction}</div>
          </div>

          <div
            style={{
              width: "100%",
              fontSize: 11,
              color: "var(--muted)",
              marginTop: 2,
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span>
              公式：朱雀% ≈ clamp({cur.a.toFixed(3)} × aiScore + {cur.b.toFixed(2)}, 0, 100)
              &nbsp;·&nbsp;
              {cur.x40 >= 0 ? `${cur.x40Tag}` : cur.x40Tag}
              &nbsp;·&nbsp;
              {cur.note}
            </span>
            {/* P6-C 快捷：当系统判断像「纯人写稿（past 极高+论说分低+无对话特征）」时提示一键切 human 负斜率轨道 */}
            {auto &&
              auto.features.narPastRatio >= 0.04 &&
              auto.features.expoScore < 0.35 &&
              auto.features.dlgColonRatio < 0.03 &&
              auto.genre === "narrative" &&
              track !== "human" && (
                <button
                  className="ghost sm"
                  onClick={() => onTrackChange("human")}
                  title="系统检测到极多过去时(口述回忆) + 低论说分 + 无对话，疑似纯人写原稿 → 切换到人写对照轨道（存档样本 H0=15%，非保证）"
                  style={{
                    fontSize: 11,
                    padding: "2px 10px",
                    color: "#fb923c",
                    border: "1px solid rgba(251,146,60,0.5)",
                    background: "rgba(251,146,60,0.1)",
                    borderRadius: 999,
                  }}
                >
                  🚩 疑似纯人写原稿 → 切人写对照轨道（H0=15%）
                </button>
              )}
            {auto && track === "human" && (
              <button
                className="ghost sm"
                onClick={resetToAuto}
                style={{
                  fontSize: 11,
                  padding: "2px 10px",
                  color: "#3ddc97",
                  border: "1px solid rgba(61,220,151,0.5)",
                  background: "rgba(61,220,151,0.1)",
                  borderRadius: 999,
                }}
              >
                ↩️ 已确认有 AI 参与生成 → 回到三分自动识别
              </button>
            )}
          </div>
        </div>
      )}

      {/* 朱雀免费版：半自动送检——复制文本 + 打开网页，用户手动检测后回填分 */}
      <div className="bench-row">
        <button
          className="ghost sm"
          onClick={() => {
            if (!output) return;
            navigator.clipboard?.writeText(output);
            window.open("https://matrix.tencent.com/ai-detect/ai_gen_txt/", "_blank");
            onNote("已复制去味文本并打开朱雀检测页——粘贴检测后，在下方填入朱雀分");
          }}
          disabled={!output}
        >
          🔍 朱雀送检（免费网页版）
        </button>
        <input
          type="number"
          min={0}
          max={100}
          value={zhuqueManualScore}
          onChange={(e) => onManualScore(e.target.value)}
          placeholder="朱雀分"
          style={{
            width: 80,
            background: "rgba(8,12,22,0.7)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "6px 8px",
            outline: "none",
          }}
        />
        {zhuqueManualScore && (
          <span
            className="tag"
            title="你手动回填的官方检测结果，仅作记录；这里的颜色不构成过检判断"
            style={{
              color: "var(--muted)",
              borderColor: "var(--border)",
              background: "rgba(148,163,184,0.08)",
            }}
          >
            朱雀回填：{zhuqueManualScore} 分（仅记录）
          </span>
        )}
      </div>
      {!api.enabled && !detector.enabled && (
        <div className="bench-tip">
          对标检测两条路径：<b>① 免费</b>
          ——点上方「朱雀送检」自动复制文本并打开朱雀网页，手动检测后回填分数；
          <b>② 自动</b>——在「设置」里点「填入朱雀默认值」并勾启用：朱雀官方 API 已于 2026-09
          开放（EdgeOne Makers <code>@makers/zhuque-text</code>，每月 50 万 token 免费，只需一个 API
          Key），去味后自动送检。
          <br />
          显示的「朱雀分趋势预测」只是本地套话指数经存档公式换算的估算，不是官方分，
          真实结果以官方网页或 API 直接返回为准。
          <br />
          📌 <b>v3 存档（2026-08-26 · 18 点 OLS）</b>：按文本实际体裁切换下拉（论说默认 / 叙事 /
          对话 / 纯人写），参考线会联动重算。样本仅 18 点且凭证未认证，误差数字不外推。
        </div>
      )}
    </div>
  );
}
