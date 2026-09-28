import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import "./globals.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("缺少桌面应用挂载节点。 ");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
