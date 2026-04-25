/**
 * AiChatContext — share aiChatOpen state ระหว่าง TopNav และ AppShell
 * เพื่อให้ AppShell บีบ content เมื่อ panel เปิด
 */
import { createContext, useContext, useState, type ReactNode } from "react";

type AiChatContextValue = {
  aiChatOpen: boolean;
  setAiChatOpen: (open: boolean) => void;
  toggleAiChat: () => void;
};

const AiChatContext = createContext<AiChatContextValue | null>(null);

export function AiChatProvider({ children }: { children: ReactNode }) {
  const [aiChatOpen, setAiChatOpen] = useState(false);
  const toggleAiChat = () => setAiChatOpen((v) => !v);
  return (
    <AiChatContext.Provider value={{ aiChatOpen, setAiChatOpen, toggleAiChat }}>
      {children}
    </AiChatContext.Provider>
  );
}

export function useAiChat() {
  const ctx = useContext(AiChatContext);
  if (!ctx) throw new Error("useAiChat must be used within AiChatProvider");
  return ctx;
}
