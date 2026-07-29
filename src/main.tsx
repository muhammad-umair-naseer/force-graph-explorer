import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";

// No StrictMode: its double-mount would create two WebGL contexts / rAF loops.
createRoot(document.getElementById("root")!).render(<App />);
