import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { createAppStore } from "./lib/store";
import "./globals.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("缺少 Web 应用挂载节点。 ");

const store = createAppStore();

createRoot(root).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);
