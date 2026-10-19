// 安全存储桥接：通过 contextBridge 暴露 safeStorage 加密存储 API 到渲染进程
// 仅限 Electron 桌面版使用；Web 版（无 window.secureStore）回退到 localStorage。
// 同时桥接本地困惑度引擎（ppl-*），Web 版无 window.ppl 自动走 Worker WASM。
// 以及本机 LLM 转发服务的端口（proxy-port），供渲染层把「/sensenova/v1」
// 相对路径改写成本机绝对地址——file:// 页取不到 file:// URL，见 src/api/desktop-proxy.ts。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("secureStore", {
  get: (key) => ipcRenderer.invoke("secure-store-get", key),
  set: (key, value) => ipcRenderer.invoke("secure-store-set", key, value),
});

// v0.9.46 预置 Key 池（SenseNova 常驻通道）：Key 放在产物根目录的 preset-keys.txt，
// 由主进程读、经此桥交给页面。该文件不入 Git，公开包不带它时返回空串。
contextBridge.exposeInMainWorld("preset", {
  keys: () => ipcRenderer.invoke("preset-keys"),
});

contextBridge.exposeInMainWorld("ppl", {
  status: () => ipcRenderer.invoke("ppl-status"),
  download: (onProgress) => {
    // 进度经事件通道推送；返回值只表达最终成败
    const listener = (_event, info) => {
      try {
        onProgress(info);
      } catch {
        /* 回调异常不影响下载 */
      }
    };
    ipcRenderer.on("ppl-progress", listener);
    return ipcRenderer.invoke("ppl-download").finally(() => {
      ipcRenderer.removeListener("ppl-progress", listener);
    });
  },
  score: (windows) => ipcRenderer.invoke("ppl-score", windows),
});

// v0.9.58 本机 LLM 转发服务端口查询。端口可能因被占而 +1（18964→18974），
// 渲染层必须问主进程要真实值，不能写死。
contextBridge.exposeInMainWorld("proxy", {
  port: () => ipcRenderer.invoke("proxy-port"),
});
