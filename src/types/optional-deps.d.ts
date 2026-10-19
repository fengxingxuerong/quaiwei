/**
 * optional 依赖的类型兜底（v0.9.16）。
 *
 * @huggingface/transformers 是**浏览器 PPL 的构建期依赖**（ppl-worker.ts 动态 import，
 * vite 只给它出独立 chunk）。CLI 单文件产物不引用它、运行时也不需要它，故
 * 2026-10-19（npm 首发准备）从 optionalDependencies 移到 devDependencies——
 * 由 npm 分发给 CLI 用户时不再被拖进 100MB+ 的原生依赖链（历史背景：CI 早已全量安装，optional 的"省流"意义
 * 在 v0.9.16 改全量后已消失，只留下"拖累 npx 用户"的代价）。
 * 此声明在任何"包不在 node_modules"的形态下兜底：ppl-worker.ts 的 import 不报
 * TS2307。PPL 功能本身有运行时守卫（isPplReady/pplStatus），缺包时优雅降级。
 *
 * 代价说明：本地正常装包时此声明可能让该模块类型提示降级为 any（编译不受影响），
 * 换取"任意安装形态下 tsc 全绿"，值得。
 */
declare module "@huggingface/transformers";
