import { useEffect, useState } from "react";
import type { AssistantContextPreview, TerminalContext } from "@stackbridge/protocol";
import { useLanguage } from "../i18n.js";
import type { AssistantController } from "./use-assistant-controller.js";

export function ContextPicker({ assistant, context }: { assistant: AssistantController; context: TerminalContext | undefined }) {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<AssistantContextPreview>();
  const [failed, setFailed] = useState(false);
  const selection = assistant.contextSelection;
  const mode = selection.contextMode ?? "auto";
  const selectionKey = JSON.stringify(selection);
  useEffect(() => {
    setPreview(undefined);
    setFailed(false);
    if (!context) return;
    const controller = new AbortController();
    void fetch(`/v1/terminal-sessions/${context.terminalSessionId}/ai-context`, {
      method: "POST", headers: { "content-type": "application/json" }, body: selectionKey, signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("Context unavailable");
      const result = await response.json() as AssistantContextPreview;
      if (!controller.signal.aborted) setPreview(result);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [context?.terminalSessionId, context?.contextVersion, context?.outputSequence, selectionKey, open, assistant.sending]);
  const provider = (assistant.conversation?.providerId ?? assistant.providerId) === "deepseek" ? "DeepSeek" : "ChatGPT";
  const model = assistant.conversation?.model ?? assistant.model;
  const displayModel = provider === "DeepSeek" ? model : assistant.models.find((item) => item.model === model)?.displayName ?? model;
  return <div className="ask-context-tools">
    <div className="ask-context-heading">
      <span title={assistant.conversation ? (zh ? "当前对话的提供方和模型已锁定；新建对话可切换" : "Provider and model locked. Start a new conversation to change them.") : model}>{provider} · {displayModel}{assistant.conversation ? " 🔒" : ""}</span>
      <button type="button" className="ghost-button compact" aria-expanded={open} onClick={() => setOpen(!open)}>{zh ? "上下文" : "Context"} ×{preview?.outputCount ?? "…"}</button>
    </div>
    <small className="ask-context-summary">{zh ? "发送至" : "Send to"} {provider} · {zh ? "终端上下文" : "Terminal context"} {preview ? `≈ ${(preview.bytes / 1024).toFixed(1)} KiB` : failed ? (zh ? "预览失败" : "preview unavailable") : "…"}</small>
    {open ? <div className="ask-context-popover" role="group" aria-label={zh ? "上下文选择" : "Context selection"}>
      <label>{zh ? "上下文模式" : "Context mode"}<select value={mode} disabled={assistant.sending} onChange={(event) => assistant.setContextSelection({ contextMode: event.target.value as "auto" | "manual" | "none", commandIds: selection.commandIds ?? [] })}>
        <option value="auto">{zh ? "自动：最近 3 条输出" : "Auto: latest 3 outputs"}</option>
        <option value="manual">{zh ? "手动：仅勾选的命令块" : "Manual: selected command blocks"}</option>
        <option value="none">{zh ? "无上下文：仅问题" : "None: question only"}</option>
      </select></label>
      <p>{mode === "none" ? (zh ? "本条消息不附带终端数据。已有对话历史仍保留。" : "No terminal data attached to this message. Existing conversation history remains.") : mode === "auto" ? (zh ? "包含当前环境、最近 20 条命令信息及最近 3 条输出。" : "Includes current environment, latest 20 command summaries and latest 3 outputs.") : (zh ? "包含当前环境和勾选的命令块，不自动附带其他命令。" : "Includes current environment and selected blocks, without other commands.")}</p>
      {mode !== "none" ? <div className="ask-context-commands">
        {preview?.commands.length === 0 ? <p>{zh ? "暂无命令块" : "No command blocks yet"}</p> : null}
        {preview?.commands.slice().reverse().map((command, index) => <div key={command.id} className="ask-context-command">
          <label><input type="checkbox" disabled={assistant.sending || mode !== "manual"} checked={mode === "auto" ? index < 3 : (selection.commandIds ?? []).includes(command.id)} onChange={(event) => assistant.setContextSelection({ contextMode: "manual", commandIds: event.target.checked ? [...(selection.commandIds ?? []), command.id] : (selection.commandIds ?? []).filter((id) => id !== command.id) })} /><code>{command.command || (zh ? "交互命令" : "Interactive command")}</code></label>
          <small>{command.cwd} · exit {command.exitCode ?? "—"}</small>
          <details><summary>{zh ? "输出预览" : "Preview output"}</summary><pre>{command.output || "—"}</pre></details>
        </div>)}
      </div> : null}
    </div> : null}
  </div>;
}
