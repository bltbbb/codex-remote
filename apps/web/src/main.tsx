import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

function updateViewportMetrics(): void {
  const viewport = window.visualViewport;
  const width = Math.min(window.innerWidth, viewport?.width ?? window.innerWidth);
  const height = viewport?.height ?? window.innerHeight;
  const left = Math.max(0, viewport?.offsetLeft ?? 0);
  const root = document.documentElement.style;
  root.setProperty("--app-width", `${width.toFixed(2)}px`);
  root.setProperty("--app-height", `${height.toFixed(2)}px`);
  root.setProperty("--app-left", `${left.toFixed(2)}px`);
  root.setProperty("--app-center-x", `${(left + width / 2).toFixed(2)}px`);
}

updateViewportMetrics();
window.addEventListener("resize", updateViewportMetrics);
window.addEventListener("orientationchange", updateViewportMetrics);
window.visualViewport?.addEventListener("resize", updateViewportMetrics);
window.visualViewport?.addEventListener("scroll", updateViewportMetrics);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
