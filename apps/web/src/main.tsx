import { createRoot } from "react-dom/client";

import { App } from "./app";
import { start } from "./store";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("页面里没有 #root。");
start();
createRoot(root).render(<App />);
