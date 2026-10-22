// 趣AI味 QuAiWei 的 DeepSeek Harness 组合包入口。
// 激活时把技能文件装入用户级技能目录 ~/.dsh/skills/，之后输入 /quaiwei 即可使用。
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "quaiwei";

const here = dirname(fileURLToPath(import.meta.url));

export function apply(ctx) {
  const source = join(here, ".dsh", "skills", "quaiwei.md");
  const targetDir = join(homedir(), ".dsh", "skills");
  const target = join(targetDir, "quaiwei.md");

  if (!existsSync(source)) {
    ctx?.logger?.warn?.(`skill file not found: ${source}`);
    return;
  }
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(source, target);
  ctx?.logger?.info?.(`quaiwei skill installed to ${target}; restart the session and run /quaiwei`);
}
