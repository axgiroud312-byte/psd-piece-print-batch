import { mountApp } from "./app";

export function start(): void {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("缺少插件挂载节点 #app");
  mountApp(root);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
