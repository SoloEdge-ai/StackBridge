import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TerminalContext } from "@stackbridge/protocol";
import { useLanguage } from "../i18n.js";
import type { AssistantController } from "./use-assistant-controller.js";

export function ProviderIdentity({ assistant }: { assistant: AssistantController }) {
  const { locale } = useLanguage();
  const provider = (assistant.conversation?.providerId ?? assistant.providerId) === "deepseek" ? "DeepSeek" : "ChatGPT";
  const model = assistant.conversation?.model ?? assistant.model;
  const name = provider === "DeepSeek" ? model : assistant.models.find((item) => item.model === model)?.displayName ?? model;
  return <span className="provider-identity" title={assistant.conversation ? (locale === "zh-CN" ? "当前对话的提供方和模型已锁定；新建对话可切换" : "Provider and model locked. Start a new conversation to change them.") : model}>{provider} · {name}{assistant.conversation ? " 🔒" : ""}</span>;
}

export function ContextPicker({ assistant, context, showProvider = true }: { assistant: AssistantController; context: TerminalContext | undefined; showProvider?: boolean }) {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog) {
      dialog.showModal();
      return () => dialog.close();
    }
  }, [open]);
  const preview = assistant.contextPreview;
  const failed = assistant.contextPreviewError;
  const selection = assistant.contextSelection;
  const mode = selection.contextMode ?? "auto";
  const provider = (assistant.conversation?.providerId ?? assistant.providerId) === "deepseek" ? "DeepSeek" : "ChatGPT";
  const selectedIds = mode === "auto" ? preview?.attachments?.map((item) => item.commandId) ?? [] : selection.commandIds ?? [];
  const modeLabel = mode === "auto" ? (zh ? "自动" : "Auto") : mode === "manual" ? (zh ? "手动" : "Manual") : (zh ? "不附带终端" : "No terminal content");
  const contextLabel = `${zh ? "上下文" : "Context"} ×${preview?.outputCount ?? "…"}`;
  const summary = `${zh ? "发送至" : "Send to"} ${provider} · ${modeLabel} · ${preview ? `≈ ${(preview.bytes / 1024).toFixed(1)} KiB` : failed ? (zh ? "预览失败" : "preview unavailable") : "…"}`;
  const remove = (id: string) => assistant.setContextSelection({ contextMode: "manual", commandIds: selectedIds.filter((item) => item !== id) });
  return <div className="ask-context-tools">
    <div className="ask-context-heading">
      {showProvider ? <ProviderIdentity assistant={assistant} /> : <span>{zh ? "本条消息" : "This message"}</span>}
      <button type="button" className="ghost-button compact context-toggle" aria-label={contextLabel} title={summary} aria-expanded={open} onClick={() => setOpen(!open)}>{modeLabel} · {zh ? "终端" : "Terminal"} ×{preview?.outputCount ?? "…"}{preview && preview.outputCount > 0 ? ` · ${(preview.bytes / 1024).toFixed(1)} KiB` : ""}{failed ? " ⚠" : ""}</button>
    </div>
    {context && (preview?.outputCount ?? 0) > 0 ? <small className="context-source" title={`${context.environmentStack.map((item) => item.label).join(" → ")} · ${context.cwd}`}>{context.environment.label}</small> : null}
    {mode !== "none" && selectedIds.length ? <div className="attachment-chips">{selectedIds.map((id) => {
      const command = preview?.commands.find((item) => item.id === id);
      return <button type="button" key={id} disabled={assistant.sending} title={command?.command ?? id} aria-label={`${zh ? "移除附件" : "Remove attachment"}: ${command?.command ?? id}`} onClick={() => remove(id)}><span>{command?.command ?? id}</span> ×</button>;
    })}</div> : null}
    {preview?.truncated ? <small className="attachment-warning">{zh ? "附件有截断或缺失 · 查看详情" : "Attachments truncated or missing · see details"}</small> : null}
    {assistant.viewedAttachments ? <button type="button" onClick={() => assistant.viewAttachments(undefined)}>{zh ? "退出历史回看" : "Return to draft context"}</button> : null}
    {open ? createPortal(<dialog className="context-dialog" ref={dialogRef} aria-label={zh ? "上下文选择" : "Context selection"} onCancel={(event) => { event.preventDefault(); setOpen(false); }} onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <header><h3>{zh ? "本条消息的终端附件" : "Terminal attachments for this message"}</h3><button type="button" autoFocus aria-label={zh ? "关闭上下文选择" : "Close context selection"} onClick={() => setOpen(false)}>×</button></header>
      <div className="ask-context-popover">
      <p className="ask-context-summary">{summary}</p>
      {context ? <p className="context-source">{context.environmentStack.map((item) => item.label).join(" → ")} · {context.cwd}</p> : null}
      {preview?.outputCount === 0 && mode === "auto" ? <p>{zh ? "无新增终端上下文；已有对话历史仍保留。" : "No new terminal context. Existing conversation history remains."}</p> : null}
      <label>{zh ? "上下文模式" : "Context mode"}<select value={mode} disabled={assistant.sending} onChange={(event) => assistant.setContextSelection({ contextMode: event.target.value as "auto" | "manual" | "none", commandIds: selection.commandIds ?? [] })}>
        <option value="auto">{zh ? "自动：最近 3 条输出" : "Auto: latest 3 outputs"}</option>
        <option value="manual">{zh ? "手动：仅勾选的命令块" : "Manual: selected command blocks"}</option>
        <option value="none">{zh ? "不附带终端内容" : "No terminal content"}</option>
      </select></label>
      <p>{mode === "none" ? (zh ? "本条消息不附带终端数据。已有对话历史仍保留。" : "No terminal data attached to this message. Existing conversation history remains.") : mode === "auto" ? (zh ? "仅附带最近三个命令块中尚未发送的内容；不会补发更早命令。" : "Only unsent content from the latest three blocks; older commands are not backfilled.") : (zh ? "命令及输出一起附带；允许显式重发。" : "Attach each command with its output; explicit repeats are allowed.")}</p>
      {preview?.truncated ? <p>{zh ? "部分内容已截断或不再保留。" : "Some content is truncated or no longer retained."}</p> : null}
      <p>{zh ? "历史可能因预算裁剪，可手动重新附带。" : "History may be trimmed to fit the budget. Reattach explicitly when needed."}</p>
      {mode !== "none" ? <div className="ask-context-commands">
        {preview?.commands.length === 0 ? <p>{zh ? "暂无命令块" : "No command blocks yet"}</p> : null}
        {preview?.commands.slice().reverse().map((command) => <div key={command.id} className="ask-context-command">
          <label><input type="checkbox" disabled={assistant.sending} checked={mode === "auto" ? preview.attachments?.some((item) => item.commandId === command.id) ?? false : (selection.commandIds ?? []).includes(command.id)} onChange={(event) => {
            const selected = mode === "auto" ? preview.attachments?.map((item) => item.commandId) ?? [] : selection.commandIds ?? [];
            assistant.setContextSelection({ contextMode: "manual", commandIds: event.target.checked ? [...new Set([...selected, command.id])] : selected.filter((id) => id !== command.id) });
          }} /><code>{command.command || (zh ? "交互命令" : "Interactive command")}</code></label>
          <small>{command.cwd} · exit {command.exitCode ?? "—"}</small>
          <details><summary>{zh ? "输出预览" : "Preview output"}</summary><pre>{command.output || "—"}</pre></details>
        </div>)}
      </div> : null}
    </div></dialog>, document.body) : null}
  </div>;
}
