import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("DSH 组合包（2026-10-22，对标 humanizer_cn 的一键安装）", () => {
  it("package.json 的 dsh.bundle 指向真实 patch，且 patch 插入的是本包", () => {
    const pkg = JSON.parse(read("package.json")) as {
      name: string;
      main?: string;
      dsh?: { bundle?: { patch?: string } };
      files?: string[];
    };
    expect(pkg.dsh?.bundle?.patch).toBe("./cordis.patch.yml");
    expect(pkg.main).toBe("index.js");
    expect(pkg.files).toContain(".dsh");
    expect(pkg.files).toContain("cordis.patch.yml");
    expect(pkg.files).toContain("index.js");
    const patch = read("cordis.patch.yml");
    expect(patch).toMatch(new RegExp(`name:\\s*${pkg.name}\\b`));
  });

  it("技能文件可被识别，且与插件入口同名", () => {
    const skill = read(".dsh/skills/quaiwei.md");
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toMatch(/^name: quaiwei$/m);
    expect(skill).toMatch(/^description: .{20,}$/m);
    expect(read("index.js")).toContain('"quaiwei.md"');
  });
});
