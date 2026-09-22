import type { ConversationMessage } from "@stackbridge/protocol";
import { useLanguage } from "../i18n.js";
import type { AssistantController } from "./use-assistant-controller.js";

export function MessageAttachments({ message, assistant }: { message: ConversationMessage; assistant: AssistantController }) {
  const { locale } = useLanguage();
  const snapshot = message.contextSnapshot;
  if (!snapshot) return null;
  const zh = locale === "zh-CN";
  return <details className="message-attachments"><summary>{zh ? "终端附件" : "Terminal attachments"} ×{snapshot.attachments.length} · {snapshot.status}</summary>
    <button type="button" onClick={() => assistant.viewAttachments(snapshot.attachments)}>{zh ? "在终端回看" : "Locate in terminal"}</button>
    {snapshot.attachments.map((attachment, index) => <div key={index}>
      <small>{attachment.environmentLabel} · {attachment.cwd}{attachment.repeated ? (zh ? " · 再次附带" : " · attached again") : ""}</small>
      <pre>{attachment.command}{"\n"}{attachment.output}</pre>
    </div>)}
  </details>;
}
