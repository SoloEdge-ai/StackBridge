import { useEffect, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { AssistantContextPreview, TerminalAttachment } from "@stackbridge/protocol";
import { useLanguage } from "../i18n.js";
import type { TerminalRanges } from "./terminal-ranges.js";

export function TerminalContextOverlay({ terminal, ranges, revision, attachments, commands, disabled, onSelect }: {
  terminal: Terminal | undefined; ranges: TerminalRanges | undefined; revision: number;
  attachments: TerminalAttachment[]; commands: AssistantContextPreview["commands"]; disabled: boolean;
  onSelect(ids: string[]): void;
}) {
  const { locale } = useLanguage();
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!terminal) return;
    const update = () => redraw((value) => value + 1);
    const subscriptions = [terminal.onScroll(update), terminal.onResize(update), terminal.onRender(update), terminal.buffer.onBufferChange(update)];
    return () => subscriptions.forEach((item) => item.dispose());
  }, [terminal]);
  void revision;
  if (!terminal || !ranges || !attachments.length) return null;
  const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
  const height = screen?.getBoundingClientRect().height ?? 0;
  const rowHeight = height / terminal.rows;
  const viewport = terminal.buffer.active.viewportY;
  let missing = false;
  const highlights = attachments.flatMap((attachment) => {
    const spans = attachment.includeCommand && attachment.start > attachment.outputStart
      ? [{ start: attachment.commandStart, end: attachment.outputStart }, { start: attachment.start, end: attachment.end }]
      : [{ start: attachment.includeCommand && attachment.start === attachment.outputStart ? attachment.commandStart : attachment.start, end: attachment.end }];
    return spans.map((span, index) => {
      const rows = ranges.rows(span.start, span.end);
      if (!rows) { missing = true; return null; }
      if (rows.last < viewport || rows.first >= viewport + terminal.rows) return null;
      return { attachment, rows, spanIndex: index, firstSpan: index === 0, lastSpan: index === spans.length - 1, top: Math.max(0, rows.first - viewport) * rowHeight,
        height: (Math.min(terminal.rows - 1, rows.last - viewport) - Math.max(0, rows.first - viewport) + 1) * rowHeight };
    });
  });
  const drag = (event: React.PointerEvent<HTMLButtonElement>, edge: "start" | "end", commandId: string) => {
    event.preventDefault(); event.stopPropagation();
    const button = event.currentTarget;
    button.setPointerCapture(event.pointerId);
    const initial = commands.findIndex((item) => item.id === commandId);
    const selected = commands.map((item, index) => attachments.some((attachment) => attachment.commandId === item.id) ? index : -1).filter((index) => index >= 0);
    const anchor = edge === "start" ? Math.max(initial, ...selected) : Math.min(initial, ...selected);
    const move = (pointer: PointerEvent) => {
      const rect = screen?.getBoundingClientRect();
      if (!rect) return;
      if (pointer.clientY < rect.top + 16) terminal.scrollLines(-1);
      if (pointer.clientY > rect.bottom - 16) terminal.scrollLines(1);
      const row = terminal.buffer.active.viewportY + Math.floor((pointer.clientY - rect.top) / rowHeight);
      let target = initial;
      let distance = Infinity;
      commands.forEach((command, index) => {
        if (command.commandStart === undefined || command.outputEnd === undefined) return;
        const block = ranges.rows(command.commandStart, command.outputEnd);
        if (!block) return;
        const nextDistance = row < block.first ? block.first - row : row > block.last ? row - block.last : 0;
        if (nextDistance < distance) { target = index; distance = nextDistance; }
      });
      onSelect(commands.slice(Math.min(anchor, target), Math.max(anchor, target) + 1).map((command) => command.id));
    };
    const finish = () => { button.removeEventListener("pointermove", move); button.removeEventListener("pointerup", finish); button.removeEventListener("pointercancel", finish); };
    button.addEventListener("pointermove", move); button.addEventListener("pointerup", finish); button.addEventListener("pointercancel", finish);
  };
  return <div className="terminal-context-overlay" aria-label={locale === "zh-CN" ? "待发送终端内容" : "Terminal attachments"}>
    {highlights.map((item) => item ? <div key={`${item.attachment.commandId}:${item.spanIndex}`} className="terminal-context-highlight" style={{ top: item.top, height: item.height }} title={item.attachment.command}>
      {Array.from({ length: Math.min(terminal.rows - 1, item.rows.last - viewport) - Math.max(0, item.rows.first - viewport) + 1 }, (_, index) => {
        const row = Math.max(viewport, item.rows.first) + index;
        const left = row === item.rows.first ? item.rows.firstColumn / terminal.cols * 100 : 0;
        const right = row === item.rows.last ? (terminal.cols - item.rows.lastColumn) / terminal.cols * 100 : 0;
        return <span key={row} className="context-row-paint" style={{ top: index * rowHeight, height: rowHeight, left: `${left}%`, right: `${right}%` }} />;
      })}
      {!item.attachment.includeCommand && item.firstSpan ? <span className="context-source-label">{item.attachment.command}</span> : null}
      {!disabled && item.firstSpan && item.attachment === attachments[0] ? <button aria-label="Extend context start" className="context-range-handle start" onPointerDown={(event) => drag(event, "start", item.attachment.commandId)} /> : null}
      {!disabled && item.lastSpan && item.attachment === attachments.at(-1) ? <button aria-label="Extend context end" className="context-range-handle end" onPointerDown={(event) => drag(event, "end", item.attachment.commandId)} /> : null}
    </div> : null)}
    {missing ? <span className="context-range-unavailable">{locale === "zh-CN" ? "部分内容已不在当前终端画面；请在附件列表查看" : "Some content is no longer locatable; inspect the attachment list"}</span> : null}
  </div>;
}
