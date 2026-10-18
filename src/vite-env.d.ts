/// <reference types="vite/client" />
// TS 7（原生编译器）起 noUncheckedSideEffectImports 默认开启：
// `import "./styles.css"` 这类副作用导入必须解析到模块声明，而 vite/client
// 正是 `*.css` 等静态资源声明的提供者。本仓库此前没有这个标准脚手架文件，
// TS 5.x 因该检查默认关闭而一直没报过错（v0.9.55 升 TS 7 时补上）。
