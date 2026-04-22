import { SECTIONS, type SectionKey } from "@shared/const";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const STORAGE_KEY = "report-system-section";

type SectionContextValue = {
  section: SectionKey | null;
  setSection: (s: SectionKey) => void;
  clearSection: () => void;
  hasSection: boolean;
};

const SectionContext = createContext<SectionContextValue | null>(null);

function readStored(): SectionKey | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(STORAGE_KEY);
  if (v && (SECTIONS as readonly string[]).includes(v)) {
    return v as SectionKey;
  }
  return null;
}

export function SectionProvider({ children }: { children: ReactNode }) {
  const [section, setSectionState] = useState<SectionKey | null>(() => readStored());

  useEffect(() => {
    if (section) window.localStorage.setItem(STORAGE_KEY, section);
  }, [section]);

  const setSection = useCallback((s: SectionKey) => setSectionState(s), []);
  const clearSection = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    setSectionState(null);
  }, []);

  const value = useMemo<SectionContextValue>(
    () => ({ section, setSection, clearSection, hasSection: Boolean(section) }),
    [section, setSection, clearSection],
  );

  return (
    <SectionContext.Provider value={value}>{children}</SectionContext.Provider>
  );
}

export function useSection(): SectionContextValue {
  const ctx = useContext(SectionContext);
  if (!ctx) throw new Error("useSection must be used inside <SectionProvider>");
  return ctx;
}
