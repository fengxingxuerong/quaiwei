/**
 * run-async 自检 —— 三条「进程没跑成」的路径必须与「程序判红」可区分（v0.9.55 工程卫生）
 *
 * 背景见 run-async.ts 头注释：某些宿主里同步派生（spawnSync）全灭，异步正常，
 * 而同步路径的失败形态是 `status === -1`——与「被测程序真的挂了」长得一模一样。
 * 这个模块存在的全部意义就是让两者可区分，可它自己此前从未被非正常路径测过。
 *
 * 本文件只补三条此前没有任何用例走到的路径：**超时 / 派生失败 / runSimple 包装**。
 * 正常路径由 7 条真实子进程用例（CLI / 门禁 / git）长期覆盖，不在此重复。
 */
import { describe, it, expect } from "vitest";
import { runAsync, runSimple } from "./run-async";

describe("runAsync 异常路径（不伪装成被测程序判红）", () => {
  it("超时：先杀再结算 —— code=-1 / timedOut=true / 日志带「已杀」说明", async () => {
    const r = await runAsync(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      timeoutMs: 400,
    });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(-1);
    expect(r.log).toContain("已杀");
  }, 15_000);

  it("派生失败：可执行文件不存在 —— code=-1 / timedOut=false / 日志带「派生失败」", async () => {
    const r = await runAsync("definitely-not-a-real-binary-xyz", [], { timeoutMs: 5000 });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(-1);
    expect(r.log).toContain("派生失败");
  }, 15_000);

  it("正常路径对照：退出码与 stdout 原样带出（防上面两条被写死成 -1 的伪实现）", async () => {
    const r = await runAsync(process.execPath, ["-e", "console.log('ok'); process.exit(3)"], {
      timeoutMs: 15_000,
    });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(3);
    expect(r.stdout.trim()).toBe("ok");
  }, 20_000);

  it("runSimple：形状恰好 {code, log}，退出码与 runAsync 一致", async () => {
    const r = await runSimple(process.execPath, ["-e", "process.exit(7)"], { timeoutMs: 15_000 });
    expect(Object.keys(r).sort()).toEqual(["code", "log"]);
    expect(r.code).toBe(7);
  }, 20_000);
});
