import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { adoptSecureApiKeys, loadApi, loadDetector, loadDetectorKeySecure } from "./store";
import type { ApiConfig } from "./api/llm";
import { hydratePresetKeys } from "./api/llm-config";
import type { DetectorConfig } from "./api/detector";
import "./styles.css";

// 桌面版（Electron）：主 API Key、Key 池与外部检测器 Key 都通过 window.secureStore
// （safeStorage 加密）加载，避免明文存 localStorage。任一 Key 存在于安全存储时，
// 对应配置对象以 localStorage 内容为底、注入解密后的 Key。
// Web 版：window.secureStore 不存在，走同步 localStorage（adoptSecureApiKeys 返回空对象，
// 于是 initialApi 保持 undefined，由 App 自己 loadApi()——与修复前逐字节一致）。
async function bootstrap() {
  // 桌面版补 Key 池必须在渲染前完成：设置面板打开时就读 SENSENOVA_PRESET.keys.length
  await hydratePresetKeys();
  const adopted = await adoptSecureApiKeys();
  let initialApi: ApiConfig | undefined;
  if (adopted.apiKey !== undefined || adopted.apiKeys !== undefined) {
    initialApi = loadApi();
    if (adopted.apiKey !== undefined) initialApi.apiKey = adopted.apiKey;
    if (adopted.apiKeys !== undefined) initialApi.apiKeys = adopted.apiKeys;
  }
  let initialDetector: DetectorConfig | undefined;
  const secureDetectorKey = await loadDetectorKeySecure();
  if (secureDetectorKey !== undefined) {
    initialDetector = loadDetector();
    initialDetector.apiKey = secureDetectorKey;
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App initialApi={initialApi} initialDetector={initialDetector} />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

// v0.9.54：bootstrap 失败必须留下可见出口。它发生在 React 挂载**之前**
// （安全存储桥/预置 Key/配置读取），ErrorBoundary 护不到这个阶段——
// 此前任何一个 rejection 都会让页面停在空白屏，用户连错误信息都看不到。
bootstrap().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  const root = document.getElementById("root");
  if (root) {
    const box = document.createElement("div");
    box.style.cssText =
      "max-width:560px;margin:80px auto;font-family:system-ui,sans-serif;padding:0 16px;line-height:1.7";
    const h = document.createElement("h1");
    h.textContent = "趣AI味启动失败";
    const p = document.createElement("p");
    p.textContent = `应用初始化时出错：${msg}`;
    const hint = document.createElement("p");
    hint.textContent =
      "可以尝试：刷新页面重试；浏览器隐私模式下允许本站点数据；或改用桌面版（设置面板里重新保存一次配置）。";
    box.append(h, p, hint);
    root.replaceChildren(box);
  }
  console.error("[QuAiWei] bootstrap failed:", e);
});
