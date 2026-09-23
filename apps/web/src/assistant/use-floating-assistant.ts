import { useLayoutEffect, useState, type CSSProperties, type PointerEvent, type RefObject } from "react";

interface Frame { left: number; top: number; width: number; height?: number }
export const floatingFrameKey = (id: string) => `stackbridge.quickAskFrame.${id}`;
function readFrame(id: string): Frame | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(floatingFrameKey(id)) ?? "null") as Frame | null;
    if (value && [value.left, value.top, value.width].every(Number.isFinite) && (value.height === undefined || Number.isFinite(value.height))) return value;
  } catch {}
  return undefined;
}

export function useFloatingAssistant(id: string, pane: HTMLElement | undefined, root: RefObject<HTMLElement | null>) {
  const [frame, setFrame] = useState<Frame | undefined>(() => readFrame(id));
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [contentHeight, setContentHeight] = useState(120);
  useLayoutEffect(() => {
    if (!root.current) return;
    const element = root.current;
    const observer = new ResizeObserver(() => setContentHeight(element.getBoundingClientRect().height));
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);
  useLayoutEffect(() => setFrame(readFrame(id)), [id]);
  useLayoutEffect(() => {
    if (!pane) return;
    const observer = new ResizeObserver(() => setBounds({ width: pane.clientWidth, height: pane.clientHeight }));
    observer.observe(pane);
    setBounds({ width: pane.clientWidth, height: pane.clientHeight });
    return () => observer.disconnect();
  }, [pane]);
  const clamp = (next: Frame): Frame => {
    const availableWidth = Math.max(0, bounds.width - 24);
    const availableHeight = Math.max(0, bounds.height - 46);
    const width = Math.min(availableWidth, Math.max(Math.min(320, availableWidth), next.width));
    const height = Math.min(availableHeight, Math.max(Math.min(120, availableHeight), next.height ?? contentHeight));
    return { width, ...(next.height === undefined ? {} : { height }), left: Math.min(Math.max(12, next.left), Math.max(12, bounds.width - width - 12)),
      top: Math.min(Math.max(34, next.top), Math.max(34, bounds.height - height - 12)) };
  };
  const begin = (event: PointerEvent<HTMLElement>, action: "move" | "resize") => {
    if (!pane || !root.current) return;
    event.preventDefault(); event.stopPropagation();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const rect = root.current.getBoundingClientRect();
    const parent = pane.getBoundingClientRect();
    const initial: Frame = { left: rect.left - parent.left, top: rect.top - parent.top, width: rect.width, height: rect.height };
    const save = (value: Frame) => { const next = clamp(value); setFrame(next); sessionStorage.setItem(floatingFrameKey(id), JSON.stringify(next)); };
    const autoHeight = action === "move" && frame?.height === undefined;
    save(autoHeight ? { left: initial.left, top: initial.top, width: initial.width } : initial);
    const move = (pointer: globalThis.PointerEvent) => {
      const dx = pointer.clientX - event.clientX;
      const dy = pointer.clientY - event.clientY;
      save(action === "move" ? { left: initial.left + dx, top: initial.top + dy, width: initial.width, ...(autoHeight ? {} : { height: rect.height }) } : { ...initial, width: initial.width + dx, height: rect.height + dy });
    };
    const stop = () => { target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", stop); target.removeEventListener("pointercancel", stop); };
    target.addEventListener("pointermove", move); target.addEventListener("pointerup", stop); target.addEventListener("pointercancel", stop);
  };
  const style: CSSProperties = frame ? { ...clamp(frame), maxHeight: Math.max(0, bounds.height - 46), overflow: "auto" }
    : { maxHeight: bounds.height > 0 ? Math.max(0, bounds.height - 46) : undefined, overflow: "auto" };
  return { fixed: !!frame, style, begin,
    compact() {
      if (!frame) return;
      const next = clamp({ left: frame.left, top: frame.top, width: 420 });
      setFrame(next); sessionStorage.setItem(floatingFrameKey(id), JSON.stringify(next));
    },
    reset() { sessionStorage.removeItem(floatingFrameKey(id)); setFrame(undefined); } };
}
