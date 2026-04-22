import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";

type NavActionsContextValue = {
  actions: ReactNode;
  setActions: (node: ReactNode) => void;
};

const NavActionsContext = createContext<NavActionsContextValue | null>(null);

export function NavActionsProvider({ children }: { children: ReactNode }) {
  const [actions, setActions] = useState<ReactNode>(null);
  return (
    <NavActionsContext.Provider value={{ actions, setActions }}>
      {children}
    </NavActionsContext.Provider>
  );
}

export function useNavActions() {
  const ctx = useContext(NavActionsContext);
  if (!ctx) throw new Error("useNavActions must be used inside NavActionsProvider");
  return ctx;
}
