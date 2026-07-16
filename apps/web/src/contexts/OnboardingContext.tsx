import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { DemoKnowledge } from "../api/demo";

const STORAGE_KEY = "akep-onboarding-v1";

interface OnboardingState {
  readonly completed: readonly number[];
  readonly demo?: DemoKnowledge;
  readonly dismissed: boolean;
}

interface OnboardingValue extends OnboardingState {
  readonly completeStep: (step: number) => void;
  readonly finish: () => void;
  readonly dismiss: () => void;
  readonly isOpen: boolean;
  readonly open: () => void;
  readonly reset: () => void;
  readonly setDemo: (demo: DemoKnowledge) => void;
  readonly setOpen: (open: boolean) => void;
}

const OnboardingContext = createContext<OnboardingValue | undefined>(undefined);

function loadState(): OnboardingState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) return JSON.parse(stored) as OnboardingState;
  } catch {
    // A private browser context may deny storage; onboarding remains usable in memory.
  }
  return { completed: [], dismissed: false };
}

export function OnboardingProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState(loadState);
  const [isOpen, setOpen] = useState(() => !state.dismissed);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // The UI still works without persistence.
    }
  }, [state]);
  const completeStep = useCallback(
    (step: number) => {
      setState((current) => {
        if (current.completed.includes(step)) return current;
        if (step > 0 && !current.completed.includes(step - 1)) return current;
        return { ...current, completed: [...current.completed, step].sort() };
      });
    },
    [],
  );
  const value = useMemo<OnboardingValue>(
    () => ({
      ...state,
      completeStep,
      dismiss: () => {
        setState((current) => ({ ...current, dismissed: true }));
        setOpen(false);
      },
      finish: () => {
        setState((current) => ({ ...current, completed: [0, 1, 2, 3, 4], dismissed: true }));
        setOpen(false);
      },
      isOpen,
      open: () => setOpen(true),
      reset: () => {
        setState({ completed: [], dismissed: false });
        setOpen(true);
      },
      setDemo: (demo) => setState((current) => ({ ...current, demo })),
      setOpen,
    }),
    [completeStep, isOpen, state],
  );
  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding(): OnboardingValue {
  const value = useContext(OnboardingContext);
  if (value === undefined) throw new Error("OnboardingProvider is missing");
  return value;
}
