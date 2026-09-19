import { useLanguage } from "../i18n.js";
import type { SplitDirection } from "./terminal-layout.js";

export interface TerminalContextMenuState {
  tabId: string;
  paneId: string;
  x: number;
  y: number;
}

interface TerminalContextMenuProps {
  menu: TerminalContextMenuState;
  commandId: string | undefined;
  splitTargetDescription: string;
  splitUnavailable: boolean;
  onAsk(paneId: string, prompt: string, commandId?: string): void;
  onSplit(target: TerminalContextMenuState, direction: SplitDirection): void;
}

export function TerminalContextMenu({
  menu,
  commandId,
  splitTargetDescription,
  splitUnavailable,
  onAsk,
  onSplit,
}: TerminalContextMenuProps) {
  const { t } = useLanguage();
  return (
    <div
      className="terminal-context-menu"
      role="menu"
      aria-label={t("终端操作")}
      style={{ left: menu.x, top: menu.y }}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        role="menuitem"
        aria-label={t("解释最近输出")}
        onClick={() => onAsk(
          menu.paneId,
          t("解释最近一条命令的输出，并告诉我是否正常。"),
          commandId,
        )}
      >
        <span className="ai-menu-icon" aria-hidden="true">✦</span>
        <span><strong>{t("解释最近输出")}</strong><small>{t("附带最近命令和输出")}</small></span>
      </button>
      <button
        role="menuitem"
        aria-label={t("修复最近命令")}
        onClick={() => onAsk(
          menu.paneId,
          t("分析最近一条命令为什么失败，并给出需要确认后执行的修复命令。"),
          commandId,
        )}
      >
        <span className="ai-menu-icon" aria-hidden="true">↗</span>
        <span><strong>{t("修复最近命令")}</strong><small>{t("生成固定到当前环境的建议")}</small></span>
      </button>
      <div className="terminal-menu-divider" />
      <button
        role="menuitem"
        aria-label={t("横向分栏（左右排列）")}
        disabled={splitUnavailable}
        onClick={() => onSplit(menu, "horizontal")}
      >
        <span className="split-menu-icon horizontal" aria-hidden="true"><i /><i /></span>
        <span><strong>{t("横向分栏")}</strong><small>{t("左右排列")} · {splitTargetDescription}</small></span>
      </button>
      <button
        role="menuitem"
        aria-label={t("纵向分栏（上下排列）")}
        disabled={splitUnavailable}
        onClick={() => onSplit(menu, "vertical")}
      >
        <span className="split-menu-icon vertical" aria-hidden="true"><i /><i /></span>
        <span><strong>{t("纵向分栏")}</strong><small>{t("上下排列")} · {splitTargetDescription}</small></span>
      </button>
    </div>
  );
}
