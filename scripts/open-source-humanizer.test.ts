import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { humanize } from "../src/engine/humanize.ts";
import { hardFidelityIssues } from "./open-source-humanizer-checks.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "scripts/fixtures/open-source");

interface HumanizerCase {
  id: string;
  request: string;
  input: string;
}

interface Draft {
  id: string;
  genre: string;
  writer: string;
  sourcePath: string;
  sha256: string;
  text: string;
}

const cases = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "humanizer-zh-cases.json"), "utf8"),
) as HumanizerCase[];
const drafts = fs
  .readFileSync(path.join(FIXTURES, "sgaofen-zh-drafts.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Draft);

const CASE_RULES: Record<string, RegExp[]> = {
  uncertain_cause: [/可能|或许/, /尚未|还未|没有.{0,3}确认/],
  three_features: [/导出/, /搜索/, /批量重命名/],
  ongoing_planned: [/正在|在.{0,6}测试/, /计划|打算/, /尚未|还未/],
  bounds_negation: [/四个|4\s*个/, /3000/, /不|未/],
  passive_unknown: [/原因.{0,8}(尚未|还未|没有).{0,3}确认/, /数量不变/, /顺序不变/, /权限不变/],
  association: [/角色.{0,8}(不清楚|不明确)/, /可能/, /没有提供记录|未提供记录/],
  already_clear: [/保存/, /关闭/, /未保存/, /丢失/],
  author_voice: [/标题/, /正文/, /附件/, /未|没/, /不太?满意|不满意/, /两天|2\s*天/],
  attributed_claim: [/未具名|匿名/, /专家|评论者/, /可能/, /没有给出测试结果|未提供测试结果/],
  quotation: [/这不是工具，而是一面镜子/],
  time_relationship: [/甲组/, /乙组/, /两组都完成|都完成工作/, /才能|才可/],
  gallery_report: [/1200/, /40/, /18/, /11/, /不能据此认定|不能因此认定/, /不代表|不等于/],
  tentative_memo: [/拿不准|犹豫/, /玩笑/, /承诺/, /没决定|尚未决定/, /期待/, /烦/],
  conditional_launch: [
    /如果/,
    /并且|且/,
    /周五/,
    /条件.{0,4}(?:不满足|不对上|未满足)/,
    /继续使用旧站/,
    /审阅完成不代表|审阅完成.{0,5}不代表/,
    /只读/,
    /暂不/,
  ],
  vendor_claim: [
    /供应商声称|供应商说/,
    /30%/,
    /尚未|没有/,
    /测量方法/,
    /两名编辑|2\s*名编辑/,
    /网络状况/,
    /供应商的说法/,
  ],
  quote_and_options: [
    /不是我不想改，而是你没说哪里错了/,
    /三种|3\s*种/,
    /保留原段/,
    /补充注释/,
    /删除重复例子/,
    /尚未选择|还没选择/,
  ],
  progress_and_permission: [
    /第一批/,
    /第二批/,
    /第三批/,
    /第一批确认/,
    /作者同意公开/,
    /没有回复授权邮件不视为同意|未回复授权邮件不视为同意/,
  ],
};

describe("开源同类测试 · Humanizer-zh 语义边界", () => {
  it.each(cases)("$id 保留事实、条件与归因", ({ id, input }) => {
    const output = humanize(input, { intensity: 0.9, seed: 42 });
    expect(hardFidelityIssues(input, output), output).toEqual([]);
    for (const rule of CASE_RULES[id] ?? []) {
      expect(output, output).toMatch(rule);
    }
    if (id === "author_voice") expect(output, output).not.toContain("未任何改动");
  });

  it("Markdown 受保护结构与步骤编号保持一致", () => {
    const input = fs.readFileSync(path.join(FIXTURES, "humanizer-zh-structure.md"), "utf8");
    const output = humanize(input, { intensity: 0.9, seed: 42 });
    expect(hardFidelityIssues(input, output), output).toEqual([]);
  });
});

describe("开源同类测试 · sgaofen 中文草稿", () => {
  it("102 条样本哈希与来源清单一致", () => {
    expect(drafts).toHaveLength(102);
    for (const draft of drafts) {
      expect(createHash("sha256").update(draft.text, "utf8").digest("hex"), draft.id).toBe(
        draft.sha256,
      );
    }
  });

  const genres = [...new Set(drafts.map((draft) => draft.genre))].sort();
  it.each(genres)("%s 体裁保真且固定种子可复现", (genre) => {
    const group = drafts.filter((draft) => draft.genre === genre);
    expect(group.length, genre).toBeGreaterThan(0);
    for (const draft of group) {
      const output = humanize(draft.text, { intensity: 0.9, seed: 42 });
      expect(hardFidelityIssues(draft.text, output), `${draft.id}\n${output}`).toEqual([]);
      expect(humanize(draft.text, { intensity: 0.9, seed: 42 }), draft.id).toBe(output);
    }
  });
});
