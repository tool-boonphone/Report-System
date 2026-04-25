/**
 * AIChatPanel — น้องเป๋าตัง AI Chat Panel
 *
 * Phase 41: เปลี่ยนจาก overlay popup เป็น fixed right panel
 * - ใช้ useAiChat() สำหรับ isOpen/onClose (ไม่รับ props)
 * - ส่ง userName จาก useAppAuth().me?.fullName
 * - เพิ่ม greeting message อัตโนมัติเมื่อ panel เปิดครั้งแรก
 * - fixed right, width 400px — AppShell จัดการ margin ให้ content ไม่ถูกทับ
 */
import { useState, useRef, useEffect } from "react";
import { X, Send, Loader2, RotateCcw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useSection } from "@/contexts/SectionContext";
import { useAiChat } from "@/contexts/AiChatContext";
import { useAppAuth } from "@/hooks/useAppAuth";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

type Message = {
  role: "user" | "assistant";
  content: string;
};

const SUGGESTED_PROMPTS = [
  "สรุปจำนวนสัญญาทั้งหมดแยกตามสถานะ",
  "ยอดหนี้เสียรวมทั้งหมดเท่าไหร่",
  "สินค้าที่ขายดีที่สุด 5 อันดับแรก",
  "ยอดชำระรวมทั้งหมดในระบบ",
  "พาร์ทเนอร์ที่มีสัญญามากที่สุด",
];

/**
 * Gradient sparkle avatar สำหรับน้องเป๋าตัง
 * section-aware: Boonphone = pink+yellow, Fastfone365 = orange+amber
 */
function PaotangAvatar({ size = "sm", section }: { size?: "sm" | "lg"; section?: string | null }) {
  const cls = size === "lg" ? "w-12 h-12" : "w-7 h-7";
  const isBoon = !section || section === "Boonphone";
  // Boonphone: ชมพู #F03E7B → เหลือง #FFD700
  // Fastfone365: ส้มทอง #F5A623 → ส้มเข้ม #E8621A
  const gradStyle = isBoon
    ? { background: "linear-gradient(135deg, #F03E7B 0%, #FF6BA8 60%, #FFD700 100%)" }
    : { background: "linear-gradient(135deg, #F5A623 0%, #F07A1A 60%, #E8621A 100%)" };
  return (
    <div
      className={cn(cls, "rounded-full flex items-center justify-center shrink-0 text-white font-semibold")}
      style={gradStyle}
    >
      {size === "lg" ? (
        <svg viewBox="0 0 24 24" fill="none" className="w-6 h-6" aria-hidden="true">
          <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z" fill="white" />
          <path d="M19 3l.75 2.25L22 6l-2.25.75L19 9l-.75-2.25L16 6l2.25-.75L19 3z" fill="white" opacity="0.8" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" className="w-3.5 h-3.5" aria-hidden="true">
          <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z" fill="white" />
        </svg>
      )}
    </div>
  );
}

export function AIChatPanel() {
  const { aiChatOpen, setAiChatOpen } = useAiChat();
  const { section } = useSection();
  const { me } = useAppAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [hasGreeted, setHasGreeted] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const sectionLabel = section ?? "Boonphone";
  // โทนสีตาม section
  const isBoon = !section || section === "Boonphone";
  // header gradient style
  const headerGradStyle = isBoon
    ? { background: "linear-gradient(135deg, #F03E7B 0%, #FF6BA8 50%, #FFD700 100%)" }
    : { background: "linear-gradient(135deg, #F5A623 0%, #F07A1A 60%, #E8621A 100%)" };
  // send button style
  const sendBtnStyle = isBoon
    ? { background: "linear-gradient(135deg, #F03E7B, #FFD700)" }
    : { background: "linear-gradient(135deg, #F5A623, #E8621A)" };
  // user bubble color
  const userBubbleCls = isBoon ? "bg-pink-500 text-white" : "bg-orange-500 text-white";
  // user avatar bg
  const userAvatarCls = isBoon ? "bg-pink-500" : "bg-orange-500";
  // focus ring color
  const inputFocusCls = isBoon ? "focus:ring-pink-400" : "focus:ring-orange-400";
  // suggested prompt hover
  const promptHoverCls = isBoon
    ? "hover:bg-pink-50 hover:text-pink-700 hover:border-pink-200"
    : "hover:bg-orange-50 hover:text-orange-700 hover:border-orange-200";

  // ชื่อผู้ใช้สำหรับ AI เรียก
  const userName = me?.fullName ?? me?.username ?? "";

  const chatMutation = trpc.ai.chat.useMutation({
    onSuccess: (data) => {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: String(data.reply) },
      ]);
    },
    onError: (err) => {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `ขออภัยนะคะ เกิดข้อผิดพลาด: ${err.message} ลองใหม่อีกครั้งได้เลยค่ะ`,
        },
      ]);
    },
  });

  // Auto-scroll เมื่อมี message ใหม่
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, chatMutation.isPending]);

  // Focus input เมื่อ panel เปิด
  useEffect(() => {
    if (aiChatOpen) {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [aiChatOpen]);

  // Greeting message อัตโนมัติเมื่อเปิด panel ครั้งแรก
  useEffect(() => {
    if (aiChatOpen && !hasGreeted) {
      setHasGreeted(true);
      const rawName = (userName ?? "").trim();
      const displayName = rawName.startsWith("พี่")
        ? rawName
        : rawName
          ? `คุณ${rawName}`
          : "";
      const greeting = displayName
        ? `สวัสดีค่ะ ${displayName}! หนูคือน้องเป๋าตัง ผู้ช่วย AI ของระบบ Report System ค่ะ 😊\n\nวันนี้กำลังดูข้อมูล **${sectionLabel}** อยู่นะคะ มีอะไรให้หนูช่วยสืบค้นหรือวิเคราะห์ข้อมูลได้เลยค่ะ`
        : `สวัสดีค่ะ! หนูคือน้องเป๋าตัง ผู้ช่วย AI ของระบบ Report System ค่ะ 😊\n\nวันนี้กำลังดูข้อมูล **${sectionLabel}** อยู่นะคะ มีอะไรให้หนูช่วยสืบค้นหรือวิเคราะห์ข้อมูลได้เลยค่ะ`;
      setMessages([{ role: "assistant", content: greeting }]);
    }
  }, [aiChatOpen, hasGreeted, userName, sectionLabel]);

  // Reset greeting เมื่อ section เปลี่ยน (เพื่อให้ทักทายใหม่กับ section ใหม่)
  useEffect(() => {
    setHasGreeted(false);
    setMessages([]);
  }, [section]);

  const sendMessage = (content: string) => {
    if (!content.trim() || chatMutation.isPending) return;
    const newMessages: Message[] = [
      ...messages,
      { role: "user", content: content.trim() },
    ];
    setMessages(newMessages);
    setInput("");
    chatMutation.mutate({
      messages: newMessages,
      section: sectionLabel,
      userName,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const clearChat = () => {
    setMessages([]);
    setInput("");
    setHasGreeted(false);
  };

  return (
    <>
      {/* Backdrop (mobile only) — ปิด panel เมื่อแตะนอก panel บน mobile */}
      {aiChatOpen && (
        <div
          className="fixed inset-0 bg-black/20 z-40 lg:hidden"
          onClick={() => setAiChatOpen(false)}
        />
      )}

      {/* Panel — fixed right, width 400px
          ใช้ translate-x animation เพื่อ slide in/out
          AppShell จัดการ marginRight ของ main content */}
      <div
        className={cn(
          "fixed top-0 right-0 h-full w-[400px] max-w-[100vw] bg-white shadow-2xl z-50 flex flex-col",
          "transition-transform duration-300 ease-in-out",
          aiChatOpen ? "translate-x-0" : "translate-x-full",
        )}
      >
        {/* Header — section-aware gradient */}
        <div
          className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 shrink-0 text-white"
          style={headerGradStyle}
        >
          <PaotangAvatar size="sm" section={section} />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm leading-tight">น้องเป๋าตัง</p>
            <p className="text-xs text-white/70 truncate">AI Assistant · {sectionLabel}</p>
          </div>
          <div className="flex items-center gap-1">
            {messages.length > 0 && (
              <button
                onClick={clearChat}
                className="p-1.5 rounded-lg hover:bg-white/20 transition-colors"
                title="ล้างการสนทนา"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={() => setAiChatOpen(false)}
              className="p-1.5 rounded-lg hover:bg-white/20 transition-colors"
              title="ปิด"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
        >
          {messages.length === 0 ? (
            /* Empty state — แสดงเมื่อยังไม่มี greeting (ช่วงโหลด) */
            <div className="flex flex-col items-center justify-center h-full gap-6 text-center">
              <PaotangAvatar size="lg" section={section} />
              <div>
                <p className="font-semibold text-gray-800 text-base">
                  น้องเป๋าตัง
                </p>
                <p className="text-sm text-gray-500 mt-1">
                  AI Assistant สำหรับข้อมูล {sectionLabel}
                </p>
              </div>
              <div className="w-full space-y-2">
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">
                  คำถามแนะนำ
                </p>
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => sendMessage(prompt)}
                    className={cn("w-full text-left text-sm px-3 py-2.5 rounded-xl bg-gray-50 border border-gray-200 transition-colors", promptHoverCls)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            /* Messages list */
            <>
              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex gap-2",
                    msg.role === "user" ? "flex-row-reverse" : "flex-row",
                  )}
                >
                  {/* Avatar */}
                  {msg.role === "assistant" ? (
                    <PaotangAvatar size="sm" section={section} />
                  ) : (
                    <div className={cn("w-7 h-7 rounded-full text-white flex items-center justify-center shrink-0 text-xs font-semibold mt-0.5", userAvatarCls)}>
                      {userName ? userName.charAt(0).toUpperCase() : "ฉ"}
                    </div>
                  )}
                  {/* Bubble */}
                  <div
                    className={cn(
                      "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm",
                      msg.role === "user"
                        ? cn(userBubbleCls, "rounded-tr-sm")
                        : "bg-gray-100 text-gray-800 rounded-tl-sm",
                    )}
                  >
                    {msg.role === "assistant" ? (
                      <div className="prose prose-sm max-w-none prose-p:my-1 prose-headings:my-1 prose-table:text-xs">
                        <Streamdown>{msg.content}</Streamdown>
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                    )}
                  </div>
                </div>
              ))}

              {/* Loading indicator */}
              {chatMutation.isPending && (
                <div className="flex gap-2">
                  <PaotangAvatar size="sm" section={section} />
                  <div className="bg-gray-100 rounded-2xl rounded-tl-sm px-4 py-3">
                    <div className="flex gap-1 items-center">
                      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:0ms]" />
                      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:150ms]" />
                      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:300ms]" />
                    </div>
                  </div>
                </div>
              )}

              {/* Suggested prompts (แสดงหลัง greeting) */}
              {messages.length === 1 && messages[0].role === "assistant" && (
                <div className="space-y-1.5 pt-2">
                  <p className="text-xs text-gray-400 font-medium uppercase tracking-wide text-center">
                    คำถามแนะนำ
                  </p>
                  {SUGGESTED_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => sendMessage(prompt)}
                      className={cn("w-full text-left text-sm px-3 py-2 rounded-xl bg-gray-50 border border-gray-200 transition-colors", promptHoverCls)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Input */}
        <div className="shrink-0 border-t border-gray-200 px-4 py-3 bg-white">
          <div className="flex gap-2 items-end">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`ถามน้องเป๋าตังเกี่ยวกับ ${sectionLabel}...`}
              rows={1}
              className="flex-1 resize-none rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent max-h-32 overflow-y-auto"
              style={{ minHeight: "42px" }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 128) + "px";
              }}
            />
            <button
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || chatMutation.isPending}
              className="w-10 h-10 rounded-xl text-white flex items-center justify-center transition-all shrink-0 disabled:opacity-40"
              style={chatMutation.isPending || !input.trim() ? undefined : sendBtnStyle}
            >
              {chatMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-1.5 text-center">
            Enter ส่ง · Shift+Enter ขึ้นบรรทัดใหม่
          </p>
        </div>
      </div>
    </>
  );
}
