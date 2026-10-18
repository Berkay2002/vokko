// Entry of the Pop Out window (popout.html, created by src-tauri/src/popout.rs). A page of its own: no gateway, no stores, no app shell.

import ReactDOM from "react-dom/client";
import "@fontsource/noto-sans/latin-400.css";
import "@fontsource/noto-sans/latin-600.css";
import { PopoutPage } from "./PopoutPage";
import "./popout.css";

const root = document.getElementById("root");
if (root) ReactDOM.createRoot(root).render(<PopoutPage />);
