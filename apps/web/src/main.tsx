import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";

import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element");

createRoot(root).render(<App />);
