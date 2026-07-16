import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { OnboardingWizard } from "../components/OnboardingWizard";
import { AgentSetupPage } from "../pages/AgentSetupPage";
import { ContributionPage } from "../pages/ContributionPage";
import { EvaluationPage } from "../pages/EvaluationPage";
import { GovernancePage } from "../pages/GovernancePage";
import { KnowledgePage } from "../pages/KnowledgePage";
import { OverviewPage } from "../pages/OverviewPage";
import { ReviewPage } from "../pages/ReviewPage";
import { SettingsPage } from "../pages/SettingsPage";

export function App() {
  return <><Routes><Route element={<AppShell />}><Route index element={<OverviewPage />} /><Route path="knowledge" element={<KnowledgePage />} /><Route path="contribute" element={<ContributionPage />} /><Route path="review" element={<ReviewPage />} /><Route path="governance" element={<GovernancePage />} /><Route path="evaluation" element={<EvaluationPage />} /><Route path="agents" element={<AgentSetupPage />} /><Route path="settings" element={<SettingsPage />} /><Route path="*" element={<Navigate replace to="/" />} /></Route></Routes><OnboardingWizard /></>;
}
