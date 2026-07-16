import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app/App";
import { OnboardingProvider } from "./contexts/OnboardingContext";
import "./styles/index.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Application root was not found");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <OnboardingProvider>
        <App />
      </OnboardingProvider>
    </BrowserRouter>
  </StrictMode>,
);
