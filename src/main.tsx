import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./immersive.css";
import "./hud.css";
import "./workspace-refresh.css";
import "./economy.css";
import "./theme.css";
import "./mobile.css";
import "./enquiry-intelligence.css";
import "./buyer-profile.css";
import "./uppercase.css";
import "./enquiry-compact.css";
import './access.css';
import { installUppercaseInputs } from "./uppercaseInputs";

const removeUppercaseInputs = installUppercaseInputs();
if (import.meta.hot) import.meta.hot.dispose(removeUppercaseInputs);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

import "./records.css";
import "./window-sizing.css";
import "./readability.css";
import "./hud-expansion.css";
import "./design-system.css";
