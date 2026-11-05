/**
 * 趣AI味 · 对标评分面板：深度轮次分、LLM 评判、外部检测器、朱雀送检回填，
 * 以及引擎体裁联动（自动识别 + 手动 override，驱动引擎 knobs）。
 *
 * v0.9.83：本地代理分 → 官方朱雀分的标定预测（v3 四体裁 18 点 OLS）已随标定子系统
 * 整体移除——aiScore 与官方分之间没有可维护的换算关系，界面不再显示任何
 * "官方分预测 / 参考线 / 换算公式"。朱雀接入只剩两条真实通道：
 * 免费网页版半自动送检回填、外部检测器接口（EdgeOne API）。
 */
import { useState, useMemo, useEffect } from "react";
import { DEEP_TARGET_SCORE, type ApiConfig } from "../api/llm";
import type { DetectorConfig } from "../api/detector";
import type { ScoreBreakdown } from "../engine/humanize";
import { classifyGenre, GENRE_ZH, type GenreResult } from "../engine/classify-genre.ts";
import { pickConflict, scoreConflict, type ScoreConflict } from "../engine/score-conflict";

/** 引擎侧体裁（P7 联动的上抛值；humanHand 不在自动识别的三分输出里，只能手动选） */
type EngineGenre = "main" | "narrative" | "dialogue" | "humanHand";

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
  /** 用户手动切换体裁时上抛；null = 回到自动识别 */
  onGenreChange?: (g: EngineGenre | null) => void;
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
  const [genre, setGenre] = useState<EngineGenre>("main");
  // 用户手动切过下拉 → 自动识别不再覆盖；点击「回到自动」按钮重置为 false
  const [genreOverrideByUser, setGenreOverrideByUser] = useState(false);

  // P6-C 自动体裁识别（memo：output 引用变化才重算）
  const auto: GenreResult | null = useMemo(() => {
    if (!output) return null;
    return classifyGenre(output);
  }, [output]);

  // 自动识别完成后，如果用户未手动 override，把体裁同步为识别结果
  useEffect(() => {
    if (!auto || genreOverrideByUser) return;
    const mapped = auto.genre;
    setGenre((prev) => (prev === mapped ? prev : mapped));
  }, [auto, genreOverrideByUser]);

  // Hooks 规则：提前 return 必须放在所有 hook 之后，
  // 否则 output 从空变非空时 hook 数量变化会直接崩掉整棵树
  if (!output) return null;

  // 用户手动切换下拉 → 标记 override
  function onGenreSelect(next: EngineGenre) {
    setGenre(next);
    // P7 引擎联动：把用户选的体裁上抛给 App → runHumanize，让引擎 knobs 真正跟随界面
    onGenreChange?.(next);
    // 仅当用户选的值和 auto 不一样才算 override；如果用户手动选的恰好等于 auto 就保持自动模式
    if (auto && next !== auto.genre) setGenreOverrideByUser(true);
    else if (auto && next === auto.genre) setGenreOverrideByUser(false);
    // humanHand 不在自动识别的三分输出里，手动选它必然是 override
    if (next === "humanHand") setGenreOverrideByUser(true);
  }
  // 「回到自动识别」按钮：清 override 标记，并立即按当前 auto 重切体裁
  function resetToAuto() {
    setGenreOverrideByUser(false);
    if (auto) setGenre(auto.genre);
    // 回到自动 → 清除引擎级 genre 强制，交还 classifyGenre 自动判定
    onGenreChange?.(null);
  }

  const score = after?.score;

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

      {/* 体裁联动：自动识别 + 手动 override。只驱动引擎 knobs（P7），不预测任何官方分 */}
      <div className="bench-row" style={{ flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        {auto && (
          <span
            className="tag"
            title={`自动识别详情 · 规则 R${auto.ruleHit}：对话dQ=${auto.features.dlgQuoteRatio.toFixed(3)}/dC=${auto.features.dlgColonRatio.toFixed(2)} · 论说分=${auto.features.expoScore.toFixed(2)} · 叙事past=${auto.features.narPastRatio.toFixed(3)}/scene=${auto.features.narSceneRatio.toFixed(3)} · 短句占比=${(auto.features.dlgShortTurn * 100).toFixed(0)}%`}
            style={{
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 999,
              border: genreOverrideByUser
                ? "1px solid rgba(250,204,21,0.55)"
                : `1px solid ${auto.confidence >= 0.7 ? "rgba(34,197,94,0.5)" : "rgba(148,163,184,0.5)"}`,
              background: genreOverrideByUser
                ? "rgba(250,204,21,0.1)"
                : auto.confidence >= 0.7
                  ? "rgba(34,197,94,0.09)"
                  : "rgba(148,163,184,0.08)",
              color: genreOverrideByUser
                ? "#facc15"
                : auto.confidence >= 0.7
                  ? "#3ddc97"
                  : "var(--muted)",
              whiteSpace: "nowrap",
              marginLeft: 6,
            }}
          >
            {genreOverrideByUser ? "⚙️ 手动体裁" : "🤖 自动识别"}
            {!genreOverrideByUser &&
              `：${GENRE_ZH[auto.genre]} ${(auto.confidence * 100).toFixed(0)}%`}
            {genreOverrideByUser && auto && (
              <button
                className="ghost sm"
                onClick={resetToAuto}
                title="根据当前文本，按自动识别结果切回体裁"
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
          value={genre}
          onChange={(e) => onGenreSelect(e.target.value as EngineGenre)}
          title="体裁切换：把选中的体裁上抛给引擎（P7 联动），影响去味 knobs；不预测官方分。系统默认自动选择，手动切换后显示「手动体裁」可点按钮回到自动。"
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
          <option value="main">论说 · 公告/报告/学术</option>
          <option value="narrative">叙事 · 散文/游记/小说</option>
          <option value="dialogue">对话 · 剧本/访谈/聊天记录</option>
          <option value="humanHand">纯人写稿对照（引擎保留作者结构）</option>
        </select>

        {/* P6-C 快捷：当系统判断像「纯人写稿（past 极高+论说分低+无对话特征）」时，
            一键把引擎体裁切到人写对照——只影响引擎行为，不做任何分数换算 */}
        {auto &&
          auto.features.narPastRatio >= 0.04 &&
          auto.features.expoScore < 0.35 &&
          auto.features.dlgColonRatio < 0.03 &&
          auto.genre === "narrative" &&
          genre !== "humanHand" && (
            <button
              className="ghost sm"
              onClick={() => onGenreSelect("humanHand")}
              title="系统检测到极多过去时(口述回忆) + 低论说分 + 无对话，疑似纯人写原稿 → 引擎体裁切到人写对照（保留作者结构）"
              style={{
                fontSize: 11,
                padding: "2px 10px",
                color: "#fb923c",
                border: "1px solid rgba(251,146,60,0.5)",
                background: "rgba(251,146,60,0.1)",
                borderRadius: 999,
              }}
            >
              🚩 疑似纯人写原稿 → 引擎保留作者结构
            </button>
          )}
        {auto && genre === "humanHand" && (
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
          界面只显示本地套话指数与真实通道返回的分数——两者不是同一把尺子，不要互相换算，
          真实结果以官方网页或 API 直接返回为准。
        </div>
      )}
    </div>
  );
}
