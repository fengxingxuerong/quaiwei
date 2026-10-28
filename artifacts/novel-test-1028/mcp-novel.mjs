/**
 * 十篇小说测试 · MCP 通道
 *
 * 拿 packaged 产物（dist-cli/quaiwei-mcp.mjs）走真 stdio 协议，喂一整篇 1 万字小说，
 * 检查：能否在协议内处理这个量级、耗时、字数、数字保真、返回是否被截断。
 * 为什么不用 src/mcp/server.ts：打包产物才是用户拿到的东西（esbuild bundle）。
 *
 * 用法：node artifacts/novel-test-1028/mcp-novel.mjs [novel-file]
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BIN = path.join(ROOT, "dist-cli", "quaiwei-mcp.mjs");
const file =
  process.argv[2] ||
  (() => {
    const dir = path.join(ROOT, "artifacts/novel-test-1028/novels");
    const f = fs.readdirSync(dir).filter((x) => x.endsWith(".md")).sort()[0];
    return path.join(dir, f);
  })();

const text = fs.readFileSync(file, "utf8");
const visible = (s) => s.replace(/\s/g, "").length;

const child = spawn(process.execPath, [BIN], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const cb = pending.get(msg.id);
    if (cb) {
      pending.delete(msg.id);
      cb(msg);
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write(d));

let nextId = 1;
function rpc(method, params, timeoutMs = 600000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), timeoutMs);
    pending.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const t0 = Date.now();
const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "novel-test", version: "1.0" },
});
await rpc("notifications/initialized", {}).catch(() => {});

const tools = await rpc("tools/list", {});
const toolNames = (tools.result?.tools || []).map((t) => t.name);

const callT0 = Date.now();
const res = await rpc("tools/call", {
  name: "humanize_text",
  arguments: { text, intensity: 0.6, style: "plain", seed: 20260905 },
});
const ms = Date.now() - callT0;
const outText = res.result?.content?.map((c) => c.text).join("\n") || "";
const sc = res.result?.structuredContent || {};

const numbers = (s) => (s.match(/\d+(?:\.\d+)?%?/g) || []).join(",");
const origNums = new Set(numbers(text).split(",").filter(Boolean));
const outNums = new Set(numbers(outText).split(",").filter(Boolean));
const missing = [...origNums].filter((n) => !outNums.has(n));

const out = {
  ts: new Date().toISOString(),
  file: path.relative(ROOT, file).replace(/\\/g, "/"),
  protocolVersion: init.result?.protocolVersion,
  serverVersion: init.result?.serverInfo?.version,
  tools: toolNames,
  charsIn: visible(text),
  charsOut: visible(outText),
  ms,
  isError: res.result?.isError ?? false,
  structured: sc,
  missingNumbers: missing.slice(0, 30),
  missingCount: missing.length,
  truncated: outText.includes("…") && visible(outText) < visible(text) * 0.5,
  replyHead: outText.slice(0, 120),
};
fs.writeFileSync(
  path.join(ROOT, "artifacts/novel-test-1028/mcp-result.json"),
  JSON.stringify(out, null, 2),
  "utf8",
);
console.log(JSON.stringify(out, null, 2));
child.kill();
