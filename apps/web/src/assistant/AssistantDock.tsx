import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLanguage } from "../i18n.js";

const widthKey = "stackbridge.aiPanelWidth";

/** Presentation-only sizing: neither moving the divider nor reopening the dock changes a turn. */
export function AssistantDock({ children }: { children: ReactNode }) {
  const { locale } = useLanguage();
  const [preferred, setPreferred] = useState(() => {
    const saved = Number(localStorage.getItem(widthKey));
    return Number.isFinite(saved) && saved > 0 ? saved : 480;
  });
  const [viewport, setViewport] = useState(window.innerWidth);
  const drag = useRef<{ x: number; width: number } | undefined>(undefined);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const maximum = Math.max(0, Math.min(720, viewport < 1000 ? viewport - 84 : viewport - 444));
  const minimum = Math.min(360, maximum);
  const width = Math.max(minimum, Math.min(preferred, maximum));
  const save = (next: number) => {
    const bounded = Math.max(minimum, Math.min(next, maximum));
    setPreferred(bounded);
    localStorage.setItem(widthKey, String(bounded));
  };
  return <div className="assistant-dock" style={{ width }}>
    <div className="assistant-dock-divider" role="separator" tabIndex={0} aria-orientation="vertical"
      aria-label={locale === "zh-CN" ? "调整 AI 面板宽度" : "Resize AI panel"}
      aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={width}
      onPointerDown={(event) => {
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width };
      }}
      onPointerMove={(event) => { if (drag.current) save(drag.current.width + drag.current.x - event.clientX); }}
      onPointerUp={() => { drag.current = undefined; }}
      onPointerCancel={() => { drag.current = undefined; }}
      onLostPointerCapture={() => { drag.current = undefined; }}
      onDoubleClick={() => save(480)}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        save(event.key === "Home" ? minimum : event.key === "End" ? maximum : width + (event.key === "ArrowLeft" ? 24 : -24));
      }} />
    {children}
  </div>;
}
