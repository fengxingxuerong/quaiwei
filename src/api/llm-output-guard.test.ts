import { describe, expect, it } from "vitest";
import { llmOutputIssues } from "./llm-output-guard.ts";

describe("LLM 客观保真门禁", () => {
  it("正常改写不误拦", () => {
    expect(
      llmOutputIssues(
        "这套方案稳定可靠、快速响应、易于维护。",
        "这套方案运行稳定，响应快，维护起来也方便。",
      ),
    ).toEqual([]);
  });

  it("新增原文没有的数字必须拦截", () => {
    expect(
      llmOutputIssues(
        " dependency resolution consumed forty percent of every run. ".trim(),
        "Dependency resolution consumed 40% of every run.",
      ),
    ).toContain("added-numbers:40%");
  });

  it("英文被翻成中文必须拦截", () => {
    expect(
      llmOutputIssues(
        "The build now finishes in nine minutes instead of twenty.",
        "构建现在九分钟就能完成，而不是二十分钟。",
      ),
    ).toContain("language-drift");
  });

  it("直接引语被删或改必须拦截", () => {
    expect(
      llmOutputIssues("作者写道：“这不是工具，而是一面镜子。”", "作者说，工具是一面镜子。"),
    ).toContain("quote-changed");
  });

  it("引号样式变化不算篡改，但引语内容必须原样保留", () => {
    expect(llmOutputIssues('作者写道："保持原意。"', "作者写道：“保持原意。”")).toEqual([]);
    expect(
      llmOutputIssues('他说："上课是副业,打卡是主业。"', "他说：“上课是副业，打卡是主业。”"),
    ).toEqual([]);
    expect(llmOutputIssues('作者写道："保持原意。"', '作者写道："稍微改一下。"')).toContain(
      "quote-changed",
    );
  });

  it("URL 后的句号不属于链接，不能据此误判丢失", () => {
    expect(
      llmOutputIssues("See https://example.com/docs.", "See https://example.com/docs"),
    ).toEqual([]);
    expect(
      llmOutputIssues("See https://example.com/docs.", "See https://example.com/other."),
    ).toContain("lost-url:https://example.com/docs");
  });

  it("标题、链接、代码块和步骤标记必须保持", () => {
    const original = [
      "# Title",
      "",
      "See [the guide](https://example.com/docs).",
      "",
      "```ts",
      "const value = 1;",
      "```",
      "",
      "1. Save the file.",
      "2. Close the window.",
      "",
      '<span id="status">Ready</span>',
    ].join("\n");
    const rewritten = [
      "Title",
      "",
      "See [the guide](https://example.com/other).",
      "",
      "```ts",
      "const value = 2;",
      "```",
      "",
      "Save the file.",
      "Close the window.",
    ].join("\n");
    const issues = llmOutputIssues(original, rewritten);
    expect(issues).toEqual(
      expect.arrayContaining([
        "headings-changed",
        "link-targets-changed",
        "fenced-code-changed",
        "step-markers-changed",
        "explicit-ids-changed",
      ]),
    );
  });

  it("原文行内代码不能丢，但允许改写稿新增行内代码", () => {
    expect(llmOutputIssues("Use the `/export` endpoint.", "Use the `/export` endpoint.")).toEqual(
      [],
    );
    expect(llmOutputIssues("Use the /export endpoint.", "Use the `/export` endpoint.")).toEqual([]);
    expect(llmOutputIssues("Use the `/export` endpoint.", "Use the endpoint.")).toContain(
      "inline-code-lost",
    );
  });

  it("严重缩水和大幅增殖必须拦截", () => {
    const original =
      "这是一段足够长的正文，用于验证严重缩水和信息增殖守卫不会被短文本误触发。".repeat(4);
    expect(llmOutputIssues(original, "太短。")).toContain("severe-shrink");
    expect(llmOutputIssues(original, original + "新增内容".repeat(200))).toContain("inflation");
  });
});
