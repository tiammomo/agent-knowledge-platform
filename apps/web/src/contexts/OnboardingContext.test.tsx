import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { OnboardingProvider, useOnboarding } from "./OnboardingContext";

function Consumer() {
  const onboarding = useOnboarding();
  return <><span>{onboarding.completed.join(",") || "none"}</span><span>{onboarding.isOpen ? "open" : "closed"}</span><button onClick={() => onboarding.completeStep(0)}>complete-0</button><button onClick={() => onboarding.completeStep(1)}>complete-1</button><button onClick={() => onboarding.completeStep(2)}>complete-2</button><button onClick={onboarding.dismiss}>dismiss</button></>;
}

describe("onboarding state", () => {
  beforeEach(() => localStorage.clear());

  it("persists progress and allows a first-run tour to be dismissed", async () => {
    const user = userEvent.setup();
    render(<OnboardingProvider><Consumer /></OnboardingProvider>);
    expect(screen.getByText("open")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "complete-2" }));
    expect(screen.getByText("none")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "complete-0" }));
    await user.click(screen.getByRole("button", { name: "complete-1" }));
    await user.click(screen.getByRole("button", { name: "complete-2" }));
    expect(screen.getByText("0,1,2")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "dismiss" }));
    expect(screen.getByText("closed")).toBeTruthy();
    expect(localStorage.getItem("akep-onboarding-v1")).toContain('"dismissed":true');
  });
});
