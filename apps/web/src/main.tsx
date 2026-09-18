import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";

import { App } from "./App.js";
import { LanguageProvider } from "./i18n.js";
import "./styles.css";

if (new URLSearchParams(location.search).get("desktop") === "1") {
  document.documentElement.classList.add("desktop-shell");
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element");

createRoot(root).render(<LanguageProvider><App /></LanguageProvider>);
