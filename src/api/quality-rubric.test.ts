import { describe, expect, it } from "vitest";
import { QUALITY_RUBRIC } from "./quality-rubric";

describe("QUALITY_RUBRIC", () => {
  it("要求输出可解析的 0~100 整数", () => {
    expect(QUALITY_RUBRIC).toContain("0 到 100 的整数");
    expect(QUALITY_RUBRIC).toContain("不要输出任何其他内容");
  });
});
