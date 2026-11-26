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
import net from "node:net";
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
  extractSection: (md: string, tag: string) => string | null;
  dirtyCodeLines: (porcelain: string) => string[];
  parseCredentialToken: (text: string) => string | null;
  sha256Line: (buf: Buffer, filename: string) => string;
  remoteShaOf: (ref: unknown) => string;
  git: (
    args: string[],
    opts?: { input?: string; inherit?: boolean; env?: NodeJS.ProcessEnv },
  ) => Promise<string>;
  probeTcp: (host: string, port: number, ms?: number) => Promise<string>;
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

describe("extractSection：章节边界与 6000 字截断", () => {
  const md = [
    "# CHANGELOG",
    "",
    "## v0.9.93 更新",
    "",
    "- 甲",
    "",
    "## v0.9.92 更新",
    "",
    "- 乙",
    "",
  ].join("\n");

  it("中间章节 → 切到下一个 `## ` 之前，不吞下一版", () => {
    const s = pub.extractSection(md, "v0.9.93");
    expect(s).toBeTruthy();
    expect(s).toContain("- 甲");
    expect(s).not.toContain("- 乙");
  });

  it("末版章节（后面没有 `## `）→ 取到文末，不切空", () => {
    const s = pub.extractSection(md, "v0.9.92");
    expect(s).toBeTruthy();
    expect(s).toContain("- 乙");
  });

  it("不存在该版 → null", () => {
    expect(pub.extractSection(md, "v9.9.9")).toBeNull();
  });

  it("超 6000 字 → 截断并标注（Release 页不被塞爆）", () => {
    const huge = "## v1.0.0 更新\n\n" + "长".repeat(6100);
    const s = pub.extractSection(huge, "v1.0.0");
    expect(s).toBeTruthy();
    expect(s!.startsWith("## v1.0.0 更新")).toBe(true);
    expect(s).toContain("完整内容见仓库");
    expect(s!.length).toBeLessThan(6100);
  });

  it("不超 6000 字 → 原样返回，不加标注", () => {
    const body = "## v2.0.0 更新\n\n" + "短".repeat(100);
    expect(pub.extractSection(body, "v2.0.0")).toBe(body);
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

/* ---------- v0.9.93 补测 ---------------------------------------------------
 * 背景：发布器 263 条语句此前只有 44 条被覆盖（16.7%），把总覆盖率从 96.3% 拖到 93.9%，
 * test:cov 门禁三项不达标。根因不是「测试写少了」，是 5706b0b 扩了 233 行之后，
 * 剩下的未覆盖语句全落在本地 IO 与网络路径上 —— 而本文件顶部一直坚持「不 mock、不联网」。
 *
 * 解法不是破纪律，是把**本地**那部分真跑起来：git 只读子命令 + 127.0.0.1 临时端口。
 * apiCall / readToken / token 仍然不进测试进程。
 * ------------------------------------------------------------------------- */

describe("dirtyCodeLines：哪些改动算进产物指纹面", () => {
  it("空输出 → 空数组（干净树）", () => {
    expect(pub.dirtyCodeLines("")).toEqual([]);
  });

  it("只改 docs/README/scripts → 不算指纹面（只提示、不拦）", () => {
    const p = [" M docs/索引投稿.md", " M README.md", "?? scripts/new.ts", " M CHANGELOG.md"].join(
      "\n",
    );
    expect(pub.dirtyCodeLines(p)).toEqual([]);
  });

  it("src/ 与 electron-app/ 下的改动 → 逐行报出", () => {
    const p = [" M src/engine/humanize.ts", " M electron-app/main.cjs"].join("\n");
    const hit = pub.dirtyCodeLines(p);
    expect(hit).toHaveLength(2);
    expect(hit[0]).toContain("src/engine/humanize.ts");
    expect(hit[1]).toContain("electron-app/main.cjs");
  });

  it("混合改动 → 只留指纹面那几行", () => {
    const p = [" M docs/a.md", "M  src/api/llm.ts", "A  electron-app/prune-dist.cjs", "?? n.txt"].join(
      "\n",
    );
    expect(pub.dirtyCodeLines(p)).toHaveLength(2);
  });

  it("重命名行也能认（porcelain 里是 `R  old -> new`）", () => {
    expect(pub.dirtyCodeLines("R  src/old.ts -> src/new.ts")).toHaveLength(1);
  });

  it("src/ 出现在路径中段（docs/src/x）→ 不误判", () => {
    expect(pub.dirtyCodeLines(" M docs/src/x.md")).toEqual([]);
  });
});

describe("parseCredentialToken：helper 输出解析", () => {
  it("标准 LF 输出 → 取到 token", () => {
    expect(
      pub.parseCredentialToken("protocol=https\nhost=github.com\nusername=u\npassword=ghp_abc\n"),
    ).toBe("ghp_abc");
  });

  it("CRLF 输出 → 尾部回车必须去掉（否则 Authorization 头带 \\r 被拒）", () => {
    const t = pub.parseCredentialToken("username=u\r\npassword=ghp_abc\r\n");
    expect(t).toBe("ghp_abc");
    expect(t).not.toContain("\r");
  });

  it("没有 password 行 → null（调用方据此 die）", () => {
    expect(pub.parseCredentialToken("username=u\n")).toBeNull();
  });

  it("空 / undefined → null，不抛", () => {
    expect(pub.parseCredentialToken("")).toBeNull();
    expect(pub.parseCredentialToken(undefined as unknown as string)).toBeNull();
  });
});

describe("sha256Line：校验码行格式", () => {
  it("已知内容 → 标准 sha256 十六进制", () => {
    const line = pub.sha256Line(Buffer.from("abc"), "a.zip");
    expect(line.startsWith("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")).toBe(
      true,
    );
  });

  it("与 sha256sum -c 兼容：64 hex + 两个空格 + 文件名 + 换行", () => {
    const line = pub.sha256Line(Buffer.from("x"), "QuAiWei-win32-x64-v0.9.93.zip");
    expect(line).toMatch(/^[0-9a-f]{64} {2}QuAiWei-win32-x64-v0\.9\.93\.zip\n$/);
  });
});

describe("remoteShaOf：形状不对就炸，不拿 undefined 去比对", () => {
  it("正常响应 → 返回 sha", () => {
    expect(pub.remoteShaOf({ object: { sha: "a".repeat(40) } })).toBe("a".repeat(40));
  });

  it("缺 object / 缺 sha / null → 抛错（而不是让下游报「远端 undefined ≠ 本地」）", () => {
    expect(() => pub.remoteShaOf(null)).toThrow(/object\.sha/);
    expect(() => pub.remoteShaOf({})).toThrow(/object\.sha/);
    expect(() => pub.remoteShaOf({ object: {} })).toThrow(/object\.sha/);
  });
});

describe("git()：只跑本地只读子命令（不 push、不联网）", () => {
  it("rev-parse HEAD → 40 位 sha", async () => {
    await expect(pub.git(["rev-parse", "HEAD"])).resolves.toMatch(/^[0-9a-f]{40}$/);
  });

  it("给 input → 走 stdin", async () => {
    // hash-object 不带 -w 不写对象库，纯粹验证 stdin 通道
    await expect(pub.git(["hash-object", "--stdin"], { input: "hello\n" })).resolves.toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
  });

  it("非 0 退出 → reject，消息带退出码（失败与「没跑」能区分）", async () => {
    await expect(
      pub.git(["rev-parse", "--verify", "refs/heads/__quaiwei_no_such_branch__"]),
    ).rejects.toThrow(/退出码 128|派生 git 失败/);
  });
});

describe("probeTcp()：只碰 127.0.0.1 的临时端口", () => {
  const withServer = async (fn: (port: number) => Promise<void>) => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      await fn(port);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  };

  it("有人监听 → ok", async () => {
    await withServer(async (port) => {
      await expect(pub.probeTcp("127.0.0.1", port, 2000)).resolves.toBe("ok");
    });
  });

  it("无人监听 → 返回错误码字符串，不抛", async () => {
    let port = 0;
    await withServer(async (p) => {
      port = p;
    }); // 出块即已关闭，此后该端口无人监听
    const r = await pub.probeTcp("127.0.0.1", port, 1500);
    expect(r).not.toBe("ok");
    expect(typeof r).toBe("string");
  });
});
