/**
 * scripts/publish-logic.test.ts —— 发布器（scripts/_publish.cjs）判定逻辑的回归测试。
 *
 * 为什么只测这几块：发布流程真正会「发错东西」的只有三类判定——
 *   1) 产物新鲜度（版本 / HEAD / dirty）—— 错了就是把旧包发出去；
 *   2) 资产重名决策（--replace 语义）—— 错了就是 zip 更新了、sha256 还是旧的；
 *   3) Release 正文抽取（CHANGELOG 章节）—— 错了就是 Release 页还在讲上一版。
 * 网络、凭据、上传这些真跑才能验，本文件刻意不碰（不 mock、不联网），
 * 它们由 `node scripts/_publish.cjs --check` / `--dry-run` 在发版时人工过一遍。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "scripts", "_publish.cjs");
const requireCjs = createRequire(import.meta.url);

/** 发布器导出的纯函数（不带类型声明，按形状断言） */
const pub = requireCjs("./_publish.cjs") as {
  checkBuildInfo: (info: unknown, ctx: { version: string; head: string }) => string[];
  planAsset: (exists: boolean, replace: boolean) => "upload" | "replace" | "skip";
  changelogBody: (tag: string) => string | null;
  DRY_RUN: boolean;
  REPLACE_ASSETS: boolean;
};

describe("发布器：require 不触发主流程", () => {
  it("导出纯函数，且测试进程里两个开关都是 false（argv 里没给）", () => {
    expect(typeof pub.checkBuildInfo).toBe("function");
    expect(typeof pub.planAsset).toBe("function");
    expect(typeof pub.changelogBody).toBe("function");
    expect(pub.DRY_RUN).toBe(false);
    expect(pub.REPLACE_ASSETS).toBe(false);
  });
});

describe("planAsset：--replace 语义只定义一次", () => {
  it("远端没有 → 上传（与 --replace 无关）", () => {
    expect(pub.planAsset(false, false)).toBe("upload");
    expect(pub.planAsset(false, true)).toBe("upload");
  });

  it("远端已有 + 不给 --replace → 跳过（幂等重跑不炸）", () => {
    expect(pub.planAsset(true, false)).toBe("skip");
  });

  it("远端已有 + 给 --replace → 删旧重传", () => {
    expect(pub.planAsset(true, true)).toBe("replace");
  });
});

describe("checkBuildInfo：四条发错包防线", () => {
  const ok = { version: "0.9.92", head: "abc1234", dirty: false };
  const ctx = { version: "0.9.92", head: "abc1234" };

  it("完全匹配 → 空数组（可以发）", () => {
    expect(pub.checkBuildInfo(ok, ctx)).toEqual([]);
  });

  it("产物章缺失或不是对象 → 明确说「缺失」，不是静默放行", () => {
    expect(pub.checkBuildInfo(null, ctx).join()).toContain("产物章缺失");
    expect(pub.checkBuildInfo("nope", ctx).join()).toContain("产物章缺失");
  });

  it("版本不一致 → 报出两个版本号（便于直接看出差在哪）", () => {
    const errs = pub.checkBuildInfo({ ...ok, version: "0.9.91" }, ctx);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("0.9.91");
    expect(errs[0]).toContain("0.9.92");
  });

  it("HEAD 不一致 → 报「产物不是这次提交打的」", () => {
    const errs = pub.checkBuildInfo({ ...ok, head: "05b680a" }, ctx);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("05b680a");
    expect(errs[0]).toContain("abc1234");
    expect(errs[0]).toContain("repack");
  });

  it("dirty=true → 报「不对应任何提交」", () => {
    const errs = pub.checkBuildInfo({ ...ok, dirty: true }, ctx);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("dirty");
  });

  it("三项全错 → 一次报全 3 条（不再修一个撞一个）", () => {
    const errs = pub.checkBuildInfo({ version: "0.0.1", head: "fffffff", dirty: true }, ctx);
    expect(errs).toHaveLength(3);
  });
});

describe("changelogBody：Release 正文抽取", () => {
  it("抽到本版章节，且带完整历史链接", () => {
    const body = pub.changelogBody("v0.9.92");
    expect(body).toBeTruthy();
    expect(body).toContain("## v0.9.92 更新");
    expect(body).toContain("CHANGELOG.md");
    // 不能把下一版章节也吞进来
    expect(body).not.toContain("## v0.9.91 更新");
  });

  it("CHANGELOG 里没有该 tag → 返回 null（调用方据此 die，不瞎凑正文）", () => {
    expect(pub.changelogBody("v99.99.99")).toBeNull();
  });

  it("超长章节截到 6000 字以内并标注「完整内容见仓库」", () => {
    for (const tag of ["v0.9.92", "v0.9.91", "v0.9.90"]) {
      const body = pub.changelogBody(tag);
      if (!body) continue;
      expect(body.length).toBeLessThan(6500);
      if (body.length >= 6000) expect(body).toContain("完整内容见仓库");
    }
  });
});

describe("--dry-run 契约：新增写操作必须重新审视预演分支", () => {
  const src = readFileSync(SRC, "utf-8");

  it("DRY_RUN 从 argv 读取（不是环境变量，也不依赖别处传参）", () => {
    expect(src).toContain('const DRY_RUN = process.argv.includes("--dry-run")');
  });

  it("预演块以 return 收尾（不是打印完继续往下发）", () => {
    const i = src.indexOf("--dry-run 结束");
    expect(i).toBeGreaterThan(0);
    const tail = src.slice(i, i + 300);
    expect(tail).toContain("return;");
  });

  /**
   * 快照计数：写操作一共 4 处（PATCH 正文 / POST 建 Release / DELETE zip / DELETE sha256）。
   * 这条断言的价值不在数字本身，而在**变更感知**：谁加了第五个写操作，
   * 这里会红，提醒他确认 --dry-run 预演是否覆盖了新动作，再更新期望值。
   */
  it("写操作（POST/PATCH/DELETE apiCall）恰好 4 处", () => {
    const writes = [...src.matchAll(/apiCall\(\s*"(POST|PATCH|DELETE)"/g)];
    expect(
      writes.length,
      "发布器新增/删除了写操作：请确认 --dry-run 预演分支覆盖它，再更新这个期望值",
    ).toBe(4);
  });
});
