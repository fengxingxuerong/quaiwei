/**
 * _publish.cjs —— 一键发布器（通用版：版本号从 package.json 现读，不再每次复制改号）
 *
 * 用法：
 *   node scripts/_publish.cjs --check   # 只自检 + 网络探测，不推不发
 *   node scripts/_publish.cjs --dry-run # 自检 + 探测 + 凭据 + 远端核对，再把将要执行的写操作逐条打出来，一条不执行
 *   node scripts/_publish.cjs           # 全流程：自检 → push → 建 Release（幂等）→ 上传 zip
 *   node scripts/_publish.cjs --replace # 重发包体：删同名 zip/sha256 资产再传，并刷新 Release 正文
 *
 * --check 与 --dry-run 的分界：--check 到网络探测就停；--dry-run 还会取凭据、核对远端 sha、
 * 读一次 release/assets（全只读），因此能回答「这次 --replace 到底会删哪个资产、传多大」。
 * 两者都不绕过前置自检——产物章对不上 HEAD 一律先 die。
 *
 * 顺序为什么是 push 在前：Release 的 tag 必须指向**已推送的** commit，
 * 先发 Release 会得到一个指向旧 master 的 tag（假发）。
 *
 * 凭据：走本机 Git Credential Manager（`git credential fill`），只在内存流转：
 * 不打印、不落盘。发布完成后本脚本可归档（scripts/archive/）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const https = require("https");
const { URL } = require("url");
const { spawn } = require("child_process");

const REPO = "fengxingxuerong/quaiwei";
const ROOT = path.join(__dirname, "..");
const { version: VERSION } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
const TAG = `v${VERSION}`;
const ZIP = path.join(ROOT, "electron-dist", `QuAiWei-win32-x64-${TAG}.zip`);
const BUILD_INFO = path.join(ROOT, "electron-app", "build-info.json");
const CHANGELOG = path.join(ROOT, "CHANGELOG.md");

/** Node 的 fetch **不读** http_proxy；Node 22.22 起可用这个开关让它走环境代理。
 *  本机网络需要它才能碰到 api.github.com。显式开着，免得哪次又连不上。 */
process.env.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY || "1";

const CHECK_ONLY = process.argv.includes("--check");
/** 重发包体用：同名 Release 资产先删后传。默认保持「已存在就跳过」的旧行为。 */
const REPLACE_ASSETS = process.argv.includes("--replace");
/**
 * 预演模式：走完自检、网络探测、凭据与远端核对，把**将要执行的写操作**逐条打出来，
 * 一条都不执行。比 `--check` 多走一段：--check 只到网络探测，
 * --dry-run 会告诉你「这次 --replace 会删哪个资产、会传多大的包、正文多长」。
 *
 * 用途：`--replace` 重发前先看一眼要动什么，以及给 `scripts/publish-logic.test.ts`
 * 一个不联网也能验证「dry-run 真的不写」的入口。
 */
const DRY_RUN = process.argv.includes("--dry-run");

const log = (...a) => console.log(...a);
const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
/**
 * 跑一条 git 命令（异步）。
 *
 * ⚠️ 为什么不用 `execFileSync`（2026-10-09 改的）：本机把 Node 的**同步**子进程派生整体挡下，
 * `spawnSync git` 一律返回 `EBUSY`（git / node / cmd.exe 全灭），而异步 `spawn` 完全正常。
 * 发布器之前直接在第一句 `git rev-parse` 上炸退——连自检都跑不到，于是"网络问题/产物过期/
 * 环境限制"三种情况的输出长得一模一样。派生失败必须能被**区分**：这里用非 0 退出码 + stderr 报出真实原因。
 *
 * @param {string[]} args
 * @param {{input?: string, inherit?: boolean, env?: NodeJS.ProcessEnv}} [opts]
 *   input = 写进 stdin（credential fill 用）；inherit = 直接把 stdio 接到本进程（push 的进度要看见）
 * @returns {Promise<string>} trim 过的 stdout
 */
function git(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const stdio = [
      opts.input === undefined ? "ignore" : "pipe",
      opts.inherit ? "inherit" : "pipe",
      opts.inherit ? "inherit" : "pipe",
    ];
    let out = "";
    let err = "";
    const child = spawn("git", ["-C", ROOT, ...args], { stdio, env: opts.env });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    if (child.stdout) {
      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (d) => {
        out += d;
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (d) => {
        err += d;
      });
    }
    child.on("error", (e) => reject(new Error(`派生 git 失败：${e.code || e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`git ${args.join(" ")} → 退出码 ${code}\n${err.trim()}`));
    });
  });
}

/**
 * 从 CHANGELOG 文本里抽出某版章节正文（纯函数，不读文件）。
 *
 * 抽出来是为了让两条边界能被验证 —— 它们在真跑里几乎撞不到，却是 Release 正文的真实风险：
 *   · 末版章节后面没有下一个 `## `，不能因为 `indexOf` 返回 -1 就切空；
 *   · 正文超过 6000 字要截断并标注，否则 GitHub Release 页会被塞爆。
 *
 * @param {string} md CHANGELOG.md 全文
 * @param {string} tag 形如 `v0.9.93`
 * @returns {string|null} 章节正文；找不到该版返回 null（调用方据此 die）
 */
function extractSection(md, tag) {
  const start = md.indexOf(`## ${tag} 更新`);
  if (start < 0) return null;
  const next = md.indexOf("\n## ", start + 4);
  const body = md.slice(start, next < 0 ? undefined : next);
  return body.length > 6000
    ? body.slice(0, 6000) + "\n\n…（完整内容见仓库 CHANGELOG.md）"
    : body;
}

/** 从 CHANGELOG 抽出本版章节正文（GitHub 支持 markdown，直接当 release notes） */
function changelogBody(tag) {
  const section = extractSection(fs.readFileSync(CHANGELOG, "utf-8"), tag);
  if (!section) return null;
  return (
    section +
    `\n\n---\n\n完整历史见 [CHANGELOG.md](https://github.com/${REPO}/blob/master/CHANGELOG.md)。`
  );
}

/**
 * 产物新鲜度判定（纯函数，precheck 与回归测试共用）。
 *
 * 为什么抽出来：这四条是「发错包」的唯一防线，此前全埋在 precheck 里，只能靠真跑触发；
 * 而真跑需要 209MB zip + 一份与当前 HEAD 匹配的产物章 —— 实际上等于没有回归测试。
 * 抽成纯函数后，`scripts/publish-logic.test.ts` 能把每条判据逐个打穿。
 *
 * @param {object|null|undefined} info electron-app/build-info.json 的内容
 * @param {{version: string, head: string}} ctx 当前 package.json 版本与 HEAD（短 sha）
 * @returns {string[]} 空数组 = 可以发布；每条是一句「为什么不行」
 */
function checkBuildInfo(info, ctx) {
  if (!info || typeof info !== "object")
    return ["产物章缺失或不是对象，先跑 npm run build + repack"];
  const errs = [];
  if (info.version !== ctx.version)
    errs.push(
      `产物版本 ${info.version} ≠ package.json 的 ${ctx.version}，先跑 npm run build + repack`,
    );
  if (info.head !== ctx.head)
    errs.push(`产物章 head=${info.head} ≠ 当前 HEAD=${ctx.head}，产物不是这次提交打的，先 repack`);
  if (info.dirty)
    errs.push("产物章 dirty=true —— 盖章时工作区有未提交改动，这份产物不对应任何提交，别发布");
  return errs;
}

/**
 * Release 资产重名决策（纯函数）。
 *
 * `--replace` 的语义只在这里定义一次：**exists + replace = 先删后传**，
 * exists 不带 replace = 跳过（旧行为，幂等重跑安全），不存在 = 上传。
 * 此前 zip 与 sha256 各写了一遍 if 链，两份逻辑漂移过一次（sha 忘记跟 replace）。
 *
 * @param {boolean} exists 远端已有同名资产
 * @param {boolean} replace 命令行是否给了 --replace
 * @returns {"upload"|"replace"|"skip"}
 */
function planAsset(exists, replace) {
  if (!exists) return "upload";
  return replace ? "replace" : "skip";
}

/**
 * 从 `git status --porcelain` 输出里挑出**进产物指纹的**改动行。
 *
 * 判据：只认 src/ 与 electron-app/ 下的改动。docs/README/scripts 改了不影响产物新鲜度
 * （产物里没有它们），所以只提示、不拦。
 *
 * @param {string} porcelain `git status --porcelain` 原样输出
 * @returns {string[]} 命中指纹面的行；空数组 = 不影响产物
 */
function dirtyCodeLines(porcelain) {
  if (!porcelain) return [];
  return porcelain.split("\n").filter((l) => /^\s*\S+\s+(src\/|electron-app\/)/.test(l));
}

/**
 * 从 credential helper 的 stdout 里取 password。
 *
 * trim 不是洁癖：helper 在 Windows 上可能吐 CRLF，`(.+)` 会把 `\r` 一并吃进捕获组，
 * 于是 Authorization 头尾部带一个回车 —— 请求直接被拒（或更糟：401 但看不出来为什么）。
 *
 * @param {string} text helper 原始输出（形如 `username=...\npassword=...\n`）
 * @returns {string|null} 取不到就是 null，由调用方 die
 */
function parseCredentialToken(text) {
  const m = String(text || "").match(/^password=(.+)$/m);
  return m ? m[1].trim() : null;
}

/**
 * 生成 sha256 校验码行。格式与 `sha256sum -c` 兼容：`<64 hex>␠␠<filename>\n`
 * （两个空格是 coreutils 的二进制/文本标记位，少一个 `sha256sum -c` 就认不了）。
 *
 * @param {Buffer} buf 包体内容
 * @param {string} filename 包名（不含目录）
 * @returns {string}
 */
function sha256Line(buf, filename) {
  return `${crypto.createHash("sha256").update(buf).digest("hex")}  ${filename}\n`;
}

/**
 * 从 GitHub `git/ref` 响应里取 commit sha。
 *
 * 抽出来的理由不是好看：此前写成 `(await apiCall(...)).object.sha`，响应形状一变
 * （或 GET 返回了意外结构）就得到 `undefined`，而随后的比对是
 * `if (remoteSha !== localHead)` —— undefined 永远不等于 localHead，会走 die 分支报一个
 * 「推送后远端 undefined ≠ 本地 HEAD」的误导性消息。宁可在这里就炸，把原因说清。
 *
 * @param {unknown} ref `GET /git/ref/heads/<branch>` 的 JSON
 * @returns {string} 40 位 sha
 */
function remoteShaOf(ref) {
  const sha = ref && ref.object && ref.object.sha;
  if (!sha) throw new Error("远端 ref 响应里没有 object.sha —— 拒绝用它做比对");
  return sha;
}

/* ---------- 1. 前置自检（异步：要在 async 上下文里取 git 状态） ---------- */
// CJS 没有顶层 await，所以自检整段包成一个 async 函数，由下面的 IIFE 第一步调用。
let head;
let branch;
let body;
let zipMB;

async function precheck() {
  log(`== [1] 前置自检（目标 ${TAG}） ==`);

  const info = JSON.parse(fs.readFileSync(BUILD_INFO, "utf-8"));
  head = await git(["rev-parse", "--short", "HEAD"]);
  branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const porcelain = await git(["status", "--porcelain"]);

  log(
    `  产物章：version=${info.version} head=${info.head} dirty=${info.dirty} 指纹文件=${info.fingerprintFiles}`,
  );
  log(`  仓库：branch=${branch} HEAD=${head}`);

  // 四条新鲜度判据抽在 checkBuildInfo 里（scripts/publish-logic.test.ts 逐条打穿），
  // 这里只负责一次性把**全部**问题报出来——分三次 die 会让修完一个再撞下一个。
  const stampErrs = checkBuildInfo(info, { version: VERSION, head });
  if (stampErrs.length) die(stampErrs.join("\n  "));

  if (porcelain) {
    const codeDirty = dirtyCodeLines(porcelain);
    if (codeDirty.length)
      die(`进产物指纹的代码有未提交改动，先提交再 repack：\n${codeDirty.join("\n")}`);
    log(
      `  工作区另有非指纹面改动 ${porcelain.split("\n").length} 项（docs/README/scripts），不影响产物新鲜度`,
    );
  }

  body = changelogBody(TAG);
  if (!body) die(`CHANGELOG.md 里找不到「## ${TAG} 更新」章节 —— 发版前先写更新日志`);
  log(`  Release 说明：取自 CHANGELOG ${TAG} 章节（${body.length} 字）`);

  if (!fs.existsSync(ZIP)) die(`找不到交付包：${ZIP}\n  先打：node artifacts/_make-zip.cjs`);
  zipMB = (fs.statSync(ZIP).size / 1048576).toFixed(1);
  log(`  交付包：${path.basename(ZIP)}  ${zipMB} MB`);
  log("  ✅ 自检通过\n");
}

/* ---------- 2. 网络探测 ---------- */
const probeTcp = (host, port, ms = 8000) =>
  new Promise((resolve) => {
    const s = net.connect(port, host);
    const done = (r) => {
      s.destroy();
      resolve(r);
    };
    s.setTimeout(ms);
    s.on("connect", () => done("ok"));
    s.on("timeout", () => done("timeout"));
    s.on("error", (e) => done(e.code || "error"));
  });

/**
 * 主流程。原本是顶层 IIFE，为了让 `scripts/publish-logic.test.ts` 能 require 本文件的
 * 纯函数而不触发真实发版，改成具名函数 + `require.main === module` 守卫。
 */
async function main() {
  await precheck();
  log("== [2] 网络探测 ==");

  const gh = await probeTcp("github.com", 443);
  const api = await probeTcp("api.github.com", 443);
  log(`  github.com:443      ${gh === "ok" ? "✅ 可达" : `❌ ${gh}`}`);
  log(`  api.github.com:443  ${api === "ok" ? "✅ 可达" : `❌ ${api}`}`);
  if (gh !== "ok") {
    log(
      "\n  ⚠️  github.com:443 不可达 —— **git push** 需要这个域（TCP 可达也不代表 TLS/握得成）。",
    );
    log("     本机实测过：代理放行 api.github.com、对 github.com 返回 502、直连超时。");
    log("     ⇒ 此时先 `node scripts/_api-push.cjs`（走 Git Data API 推提交），");
    log("       远端同步后再回来发版。别盲目循环重试 push（会挂住十几分钟）。");
  }
  if (CHECK_ONLY) {
    log("\n--check 模式：到此为止，未推未发。");
    return;
  }

  /* ---------- 3. 取凭据（只在内存）——提前：核对远端不再依赖 git ls-remote ---------- */
  /* 本机 `git credential fill` 会经 selector 调 git-credential-manager.exe，
   * 而后者在本机必崩（0xC0000005）。同目录的 wincred 后端正常，直接问它要。
   * 凭据仍只在内存里流转：不打印、不落盘。 */
  const CRED_HELPER =
    "C:/Program Files/WorkBuddy/resources/vendor/PortableGit/mingw64/bin/git-credential-wincred.exe";
  const readToken = () =>
    new Promise((resolve, reject) => {
      const child = spawn(CRED_HELPER, ["get"], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (d) => (out += d));
      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) =>
        reject(new Error(`派生 credential helper 失败：${e.code || e.message}`)),
      );
      child.on("close", (code) => {
        if (code !== 0)
          return reject(new Error(`credential helper → 退出码 ${code}\n${err.trim()}`));
        resolve(out);
      });
      child.stdin.end("protocol=https\nhost=github.com\n\n");
    });

  const cred = await readToken();
  const token = parseCredentialToken(cred);
  if (!token) die("没取到 GitHub 凭据（Git Credential Manager 里没有？）");

  const apiCall = async (method, url, payload) => {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "quaiwei-publish",
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null; // DELETE 204 没有响应体
  };

  /* ---------- 4. push（远端已同步则跳过） ---------- */
  log(`\n== [3] push ${branch} ==`);
  const localHead = await git(["rev-parse", "HEAD"]);
  const remoteRef = async () =>
    remoteShaOf(
      await apiCall("GET", `https://api.github.com/repos/${REPO}/git/ref/heads/${branch}`),
    );
  const remoteBefore = await remoteRef();
  if (remoteBefore === localHead) {
    log("  远端已是最新，跳过 push");
  } else if (DRY_RUN) {
    log(
      `  [dry-run] 将 push ${branch}：远端 ${remoteBefore.slice(0, 7)} → 本地 ${localHead.slice(0, 7)}`,
    );
  } else {
    // 本机环境实测（2026-09-27）：代理对 github.com 返回 502、直连反而正常。
    // 但环境会变，所以两条路都试：先清掉代理环境变量直连，失败再交给 git 自己读环境里的代理。
    const noProxyEnv = { ...process.env };
    for (const k of [
      "https_proxy",
      "HTTPS_PROXY",
      "http_proxy",
      "HTTP_PROXY",
      "all_proxy",
      "ALL_PROXY",
    ])
      delete noProxyEnv[k];
    // git() 自己会带 -C ROOT，这里只需要额外参数
    const common = [
      "-c",
      "http.lowSpeedLimit=1000",
      "-c",
      "http.lowSpeedTime=15",
      "push",
      "origin",
      branch,
    ];
    let ok = false;
    for (const [label, env, extra] of [
      ["直连（已清代理变量）", noProxyEnv, ["-c", "http.proxy=", "-c", "https.proxy="]],
      ["走环境代理", process.env, []],
    ]) {
      if (ok) break;
      log(`  尝试 ${label}…`);
      try {
        // stdio 接出来，push 的百分比进度要看得见（等待时不知道是在传还是在挂）
        await git([...extra, ...common], { env, inherit: true });
        ok = true;
      } catch (e) {
        log(`  ✗ ${label} 失败：${String(e.message).split("\n")[0]}`);
      }
    }
    if (!ok)
      die(
        "push 失败。可改用 `node scripts/_api-push.cjs`（Git Data API）推完再回来发版；不要改用其它协议/上游绕过",
      );
  }
  // 预演模式跳过这条核对：dry-run 明确不写，远端本来就该停在旧 sha 上
  if (!DRY_RUN) {
    const remoteSha = await remoteRef();
    if (remoteSha !== localHead)
      die(
        `推送后远端 ${remoteSha.slice(0, 7)} ≠ 本地 HEAD ${localHead.slice(0, 7)}，别继续发 Release`,
      );
    log(`  ✅ 远端 ${branch} = ${remoteSha.slice(0, 7)}（经 API 核对，不依赖 git ls-remote）`);
  }

  /* ---------- 4.5 --dry-run：把剩下的写操作逐条打出来，一条都不执行 ---------- */
  /* 位置讲究：放在 push 核对之后、建 Release 之前。到这里自检、网络、凭据、远端一致
   * 都已经真实走过（这四步全是只读），所以预演结果是「真会发生什么」，不是纸上推演。 */
  if (DRY_RUN) {
    log(`\n== [4] Release ${TAG} ==`);
    let planned = null;
    try {
      planned = await apiCall("GET", `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`);
    } catch {
      // tag 还没有 Release —— 预演里同样是「去新建」
    }
    if (planned) {
      log(
        `  [dry-run] 已存在 id=${planned.id}：将 PATCH 正文（${body.length} 字，取自 CHANGELOG ${TAG} 章节）`,
      );
    } else {
      log(
        `  [dry-run] 将 POST 新建 Release（tag=${TAG}, target=${branch}，正文 ${body.length} 字）`,
      );
    }
    // 资产计划需要一次只读 GET：没有 Release 就没有资产，直接按「全都要上传」算
    const plannedAssets = planned
      ? await apiCall("GET", `https://api.github.com/repos/${REPO}/releases/${planned.id}/assets`)
      : [];
    const zipName = path.basename(ZIP);
    for (const [n, label] of [
      [zipName, "zip"],
      [`${zipName}.sha256`, "sha256"],
    ]) {
      const hit = plannedAssets.find((a) => a.name === n);
      const act = planAsset(Boolean(hit), REPLACE_ASSETS);
      const sizeMB = hit ? (hit.size / 1048576).toFixed(1) : "—";
      const text =
        act === "upload"
          ? "上传（远端无同名资产）"
          : act === "replace"
            ? `删除重传（远端已有 ${sizeMB} MB）`
            : `跳过（远端已有 ${sizeMB} MB，未给 --replace）`;
      log(`  [dry-run] ${label} ${n} → ${text}`);
    }
    log("\n--dry-run 结束：以上动作一条都没执行，zip/sha256 也未落盘。");
    return;
  }

  /* ---------- 5. 建 Release（幂等） ---------- */
  log(`\n== [4] Release ${TAG} ==`);
  let release;
  let existing = null;
  try {
    existing = await apiCall("GET", `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`);
  } catch {
    // 该 tag 还没有 Release，下面新建。GET 失败与 PATCH 失败必须分开，别把 PATCH 报错吞成「去新建」。
  }
  if (existing) {
    // 复用时旧正文不会自己更新：包体修订的说明必须跟着 CHANGELOG 走，否则 Release 页还在讲上一版。
    release = await apiCall(
      "PATCH",
      `https://api.github.com/repos/${REPO}/releases/${existing.id}`,
      { body },
    );
    log(`  已存在，复用 id=${release.id}（正文已同步 CHANGELOG）`);
  } else {
    release = await apiCall("POST", `https://api.github.com/repos/${REPO}/releases`, {
      tag_name: TAG,
      target_commitish: branch,
      name: TAG,
      body,
    });
    log(`  已创建 id=${release.id}`);
  }

  /* ---------- 6. 上传 zip + sha256 ---------- */
  const name = path.basename(ZIP);
  const buf = fs.readFileSync(ZIP); // 一次读取：上传与算校验码共用，避免 200MB 读两遍
  const assets = await apiCall(
    "GET",
    `https://api.github.com/repos/${REPO}/releases/${release.id}/assets`,
  );
  const dup = assets.find((a) => a.name === name);
  const zipPlan = planAsset(Boolean(dup), REPLACE_ASSETS);
  if (zipPlan === "replace") {
    await apiCall("DELETE", `https://api.github.com/repos/${REPO}/releases/assets/${dup.id}`);
    log(`\n== [5] 已删除同名旧资产 ${name}（${(dup.size / 1048576).toFixed(1)} MB），准备重传`);
  } else if (zipPlan === "skip") {
    log(
      `\n== [5] 资源 ${name} 已存在（${(dup.size / 1048576).toFixed(1)} MB），跳过上传；要覆盖加 --replace`,
    );
  }
  if (zipPlan !== "skip") {
    log(`\n== [5] 上传 ${name}（${zipMB} MB）==`);
    // 为什么不用 fetch：209MB 上传实测在 285s 撞上 undici 固定的 300s headersTimeout，
    // 而 RequestInit 调不了这个值（不是 socket 空闲超时，是「请求发出后多久必须见到响应头」）。
    // 2026-11-26 v0.9.92 发布就是这样挂的：Release 建好了、资产没传上。
    // 改 https.request 流式发送：不设空闲超时、边读边传、每 15 秒报一次进度。
    const up = await new Promise((resolve, reject) => {
      const u = new URL(
        `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      );
      const req = https.request(
        {
          method: "POST",
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "quaiwei-publish",
            "Content-Type": "application/zip",
            "Content-Length": buf.length,
          },
        },
        (res) => {
          let out = "";
          res.setEncoding("utf-8");
          res.on("data", (d) => (out += d));
          res.on("end", () => resolve({ status: res.statusCode, text: out }));
        },
      );
      req.setTimeout(0); // 关掉空闲超时：慢链路下 209MB 可能要传十几分钟
      req.on("error", reject);
      const rs = fs.createReadStream(ZIP);
      let sent = 0;
      let mark = Date.now();
      rs.on("data", (c) => {
        sent += c.length;
        if (Date.now() - mark >= 15000) {
          mark = Date.now();
          log(`  … ${(sent / 1048576).toFixed(1)}/${zipMB} MB`);
        }
      });
      rs.on("error", reject);
      rs.pipe(req);
    });
    if (up.status >= 300) die(`上传失败 → ${up.status} ${up.text.slice(0, 300)}`);
    log(`  ✅ 上传完成：${JSON.parse(up.text).browser_download_url}`);
  }

  /* v0.9.84 起：校验码随包上传。此前发布器只传 zip，而 SCORECARD 写「zip + sha256」，
   * 用户拿不到校验文件、没法验文件真假。格式兼容 sha256sum -c：<hex>␠␠<filename>\n，
   * 同时在 electron-dist/ 落盘一份，便于打完 zip 连校验码一起复制到仓库外。 */
  const shaName = `${name}.sha256`;
  const shaText = sha256Line(buf, name);
  fs.writeFileSync(`${ZIP}.sha256`, shaText, "ascii");
  log(`\n== [6] 校验码 ${shaName} ==\n  ${shaText.trim()}`);
  const shaDup = assets.find((a) => a.name === shaName);
  const shaPlan = planAsset(Boolean(shaDup), REPLACE_ASSETS);
  if (shaPlan === "replace") {
    await apiCall("DELETE", `https://api.github.com/repos/${REPO}/releases/assets/${shaDup.id}`);
    log("  已删除同名旧校验码，准备重传");
  } else if (shaPlan === "skip") {
    log("  已存在，跳过上传；要覆盖加 --replace");
  }
  if (shaPlan !== "skip") {
    const upRes = await fetch(
      `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(shaName)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "quaiwei-publish",
          "Content-Type": "text/plain",
        },
        body: Buffer.from(shaText, "ascii"),
      },
    );
    const upText = await upRes.text();
    if (!upRes.ok) die(`校验码上传失败 → ${upRes.status} ${upText.slice(0, 300)}`);
    log(`  ✅ 上传完成：${JSON.parse(upText).browser_download_url}`);
  }

  log(`\n🎉 ${TAG} 发布完成：https://github.com/${REPO}/releases/tag/${TAG}`);
  log(`   收尾：把 README 下载行的版本号改成 ${VERSION}，再提交推送。`);
}

/**
 * 导出面（消费方：`scripts/publish-logic.test.ts`）。
 *
 * 底线不动：**不导出** apiCall / readToken / token —— 发布器的网络与凭据面不进测试进程。
 *
 * v0.9.93 起额外导出两样本地能力，因为它们的性质与上面不同：
 *   · git()      —— 测试只跑 rev-parse / hash-object 这类只读本地子命令，不 push
 *   · probeTcp() —— 测试只连 127.0.0.1 的临时端口，不碰 GitHub
 *
 * 为什么必须开这个口子：发布器 263 条语句此前只有 44 条被覆盖（16.7%），
 * 把总覆盖率从 96.3% 拖到 93.9%，`test:cov` 门禁三项不达标。
 * 而「再多抽几个纯函数」这条路已到头 —— 剩下的未覆盖语句全在本地 IO 与网络路径上。
 * 与其为网络写 mock（违反本文件头部的既定纪律），不如给本地 IO 一个真跑的口子。
 */
module.exports = {
  checkBuildInfo,
  planAsset,
  changelogBody,
  extractSection,
  dirtyCodeLines,
  parseCredentialToken,
  sha256Line,
  remoteShaOf,
  git,
  probeTcp,
  DRY_RUN,
  REPLACE_ASSETS,
};

if (require.main === module) main();
