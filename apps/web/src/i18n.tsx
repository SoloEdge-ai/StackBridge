import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Locale = "en" | "zh-CN";

const localeStorageKey = "stackbridge.locale";

const english = {
  "正在连接本地 Core…": "Connecting to local Core…",
  "无法连接本地 Core。": "Unable to connect to local Core.",
  "重新连接": "Retry",
  "本地会话已失效": "The local session has expired.",
  "无法创建终端": "Unable to create the terminal.",
  "无法关闭终端": "Unable to close the terminal.",
  "正在创建终端": "Creating terminal…",
  "同一 Docker 目标 · 重新核验": "Same Docker target · reverify",
  "同一 SSH 目标 · 重新核验": "Same SSH target · reverify",
  "新 PowerShell": "New PowerShell",
  "正在识别环境": "Identifying environment",
  "终端窗格": "Terminal pane",
  "环境已核验": "Environment verified",
  "环境未核验": "Environment unverified",
  "关闭这个分栏": "Close this split",
  "工作台导航": "Workspace navigation",
  "终端": "Terminal",
  "新建连接": "New connection",
  "AI 助手": "AI assistant",
  "设置": "Settings",
  "关闭终端": "Close terminal",
  "新建本地终端": "New local terminal",
  "正在准备终端…": "Preparing terminal…",
  "终端分栏": "Split terminal",
  "横向分栏（左右排列）": "Split horizontally (side by side)",
  "横向分栏": "Split horizontally",
  "左右排列": "Side by side",
  "纵向分栏（上下排列）": "Split vertically (stacked)",
  "纵向分栏": "Split vertically",
  "上下排列": "Stacked",
  "已连接真实 PTY": "Connected to real PTY",
  "Shell 已退出": "Shell exited",
  "当前页面持有写入租约": "This window holds the write lease",
  "另一页面持有写入租约": "Another window holds the write lease",
  "与 Core 的连接中断": "Connection to Core was lost",
  "终端连接失败": "Terminal connection failed",
  "请求失败": "Request failed",
  "正在连接 Codex…": "Connecting to Codex…",
  "让终端自己解释终端": "Let the terminal explain itself",
  "直接询问刚才的命令和输出。StackBridge 会自动带上当前主机、容器、目录和 Shell。": "Ask about the command or output you just saw. StackBridge automatically includes the current host, container, directory, and shell.",
  "理解现场": "Understand context",
  "自动关联最近命令与输出": "Automatically includes recent commands and output",
  "给出命令": "Suggest a command",
  "建议始终固定到当前环境": "Suggestions stay bound to the current environment",
  "确认再执行": "Confirm before running",
  "每条命令都由你最终决定": "You decide before every command runs",
  "授权页面已打开。完成后回到这里检查状态；若网络或地区不可用，可以取消后重试。": "The authorization page is open. Return here when finished to check the status; you can cancel and retry if needed.",
  "检查登录状态": "Check login status",
  "取消本次登录": "Cancel login",
  "使用 ChatGPT 登录": "Sign in with ChatGPT",
  "登录凭据保存在 StackBridge 独立 Codex 数据目录的认证文件中。": "Sign-in credentials are stored in the authentication file inside StackBridge's isolated Codex data directory.",
  "新对话": "New conversation",
  "历史对话": "Conversation history",
  "识别环境中": "Identifying environment",
  "检查上下文": "Inspect context",
  "不用复制终端输出": "No need to copy terminal output",
  "直接问“刚才的错误是什么意思？”或“这个命令怎么写？”。": "Just ask “What does that error mean?” or “How should I write this command?”.",
  "解释刚才的输出": "Explain the last output",
  "给我一个安全的排查命令": "Give me a safe diagnostic command",
  "当前在哪个环境？": "Which environment am I in?",
  "你": "You",
  "环境": "Environment",
  "解释这条命令执行后的输出，并告诉我是否正常。": "Explain the output of this command and tell me whether it is normal.",
  "Codex 正在分析当前终端…": "Codex is analyzing the current terminal…",
  "问当前命令、输出或下一步…": "Ask about the current command, output, or next step…",
  "Enter 发送 · Shift+Enter 换行": "Enter to send · Shift+Enter for a new line",
  "停止": "Stop",
  "发送 ↑": "Send ↑",
  "命令建议": "Command suggestion",
  "本机": "This computer",
  "容器": "Container",
  "当前用户": "Current user",
  "当前目录": "Current directory",
  "在此终端执行": "Run in this terminal",
  "放入输入行": "Insert into command line",
  "暂不执行": "Don't run",
  "正在提交…": "Submitting…",
  "退出码": "Exit code",
  "解释结果": "Explain result",
  "SSH 宿主": "SSH host",
  "远端 Docker": "Remote Docker",
  "主机": "Host",
  "端口": "Port",
  "用户": "User",
  "容器名称或 ID": "Container name or ID",
  "容器用户": "Container user",
  "工作目录": "Working directory",
  "使用系统 OpenSSH 配置和密钥。Core 会先核验主机与运行实例，再打开真实交互 PTY。": "Uses the system OpenSSH configuration and keys. Core verifies the host and runtime instance before opening a real interactive PTY.",
  "需要部署远端 Runtime": "Remote runtime deployment required",
  "将固定版本运行时安装到登录用户的 ~/.sbridge。不会修改系统目录或 Shell 配置。": "Installs a pinned runtime in the signed-in user's ~/.sbridge directory. System directories and shell configuration are not modified.",
  "确认部署并连接": "Approve deployment and connect",
  "正在核验…": "Verifying…",
  "连接": "Connect",
  "工作台设置": "Settings",
  "语言": "Language",
  "AI 面板快捷键": "AI panel shortcut",
  "支持 Ctrl、Shift、Alt 与单个按键，例如 Ctrl+Shift+Space。中文输入法组合期间不会拦截。": "Supports Ctrl, Shift, Alt, and one key, for example Ctrl+Shift+Space. Input method composition is never intercepted.",
  "保存": "Save",
  "无法保存语言设置。": "Unable to save the language setting.",
  "等待确认": "Awaiting confirmation",
  "已提交": "Submitted",
  "执行中": "Running",
  "完成": "Completed",
  "失败": "Failed",
  "已中断": "Interrupted",
  "状态未知": "Status unknown",
  "已放入输入行": "Inserted into command line",
  "未执行": "Not run",
  "已过期": "Expired",
  "需要重新确认": "Needs confirmation again",
  "终端数量已达上限，请先关闭不用的标签。": "The terminal limit has been reached. Close an unused tab first.",
  "远端连接数量已达上限，请先关闭不用的标签。": "The remote connection limit has been reached. Close an unused tab first.",
  "远端终端服务当前不可用。": "The remote terminal service is currently unavailable.",
  "这个终端已经关闭。": "This terminal has already closed.",
  "发生未知错误": "An unknown error occurred.",
  "正在附着终端": "Attaching terminal…",
} as const satisfies Record<string, string>;

export type MessageKey = keyof typeof english;

interface LanguageContextValue {
  locale: Locale;
  setLocale(locale: Locale): Promise<void>;
  t(source: MessageKey): string;
}

const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() =>
    localStorage.getItem(localeStorageKey) === "zh-CN" ? "zh-CN" : "en",
  );
  const value = useMemo<LanguageContextValue>(() => ({
    locale,
    async setLocale(next) {
      const previous = locale;
      localStorage.setItem(localeStorageKey, next);
      setLocaleState(next);
      try {
        const response = await fetch("/v1/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ locale: next }),
        });
        if (!response.ok) throw new Error(`Settings request failed (${response.status})`);
      } catch (error) {
        localStorage.setItem(localeStorageKey, previous);
        setLocaleState(previous);
        throw error;
      }
    },
    t(source) {
      return locale === "zh-CN" ? source : english[source] ?? source;
    },
  }), [locale]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const response = await fetch("/v1/settings", { cache: "no-store" });
        if (!response.ok) return;
        const result = await response.json() as { locale?: unknown };
        if (!disposed && (result.locale === "en" || result.locale === "zh-CN")) {
          localStorage.setItem(localeStorageKey, result.locale);
          setLocaleState(result.locale);
        }
      } catch {}
    };
    const authenticated = () => void load();
    window.addEventListener("stackbridge:authenticated", authenticated);
    void load();
    return () => {
      disposed = true;
      window.removeEventListener("stackbridge:authenticated", authenticated);
    };
  }, []);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) throw new Error("useLanguage must be used inside LanguageProvider");
  return value;
}

export function localizedEnvironmentLabel(
  label: string,
  kind: "local" | "ssh" | "docker",
  locale: Locale,
): string {
  if (kind === "local" && (label === "本地 Windows" || label === "Local Windows")) {
    return locale === "zh-CN" ? "本地 Windows" : "Local Windows";
  }
  return label;
}

export function localizedConversationTitle(title: string, locale: Locale): string {
  if (title === "新对话" || title === "New conversation") {
    return locale === "zh-CN" ? "新对话" : "New conversation";
  }
  return title;
}

export function localizedSystemMessage(content: string, locale: Locale): string {
  const prefixes = ["当前环境：", "切换到：", "Current environment: ", "Switched to: "];
  const prefix = prefixes.find((candidate) => content.startsWith(candidate));
  if (!prefix) return content;
  const environment = content.slice(prefix.length).split(" → ").map((part, index) =>
    index === 0 ? localizedEnvironmentLabel(part, "local", locale) : part).join(" → ");
  const isFirst = prefix === "当前环境：" || prefix === "Current environment: ";
  if (locale === "zh-CN") return `${isFirst ? "当前环境：" : "切换到："}${environment}`;
  return `${isFirst ? "Current environment: " : "Switched to: "}${environment}`;
}

export function localizedKnownText(content: string, locale: Locale): string {
  for (const [chinese, translated] of Object.entries(english)) {
    if (content === chinese || content === translated) {
      return locale === "zh-CN" ? chinese : translated;
    }
  }
  const shellExitedEnglish = english["Shell 已退出"];
  for (const prefix of ["Shell 已退出", shellExitedEnglish]) {
    if (content.startsWith(`${prefix} (`)) {
      return `${locale === "zh-CN" ? "Shell 已退出" : shellExitedEnglish}${content.slice(prefix.length)}`;
    }
  }
  return content;
}
