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
  "终端状态已变化。重新检查原终端后，才能再次确认执行。": "Terminal state changed. Recheck the original terminal before confirming again.",
  "已重新检查。请核对命令与原执行目标，再确认执行。": "Rechecked. Review the command and original target, then confirm.",
  "正在重新检查…": "Rechecking…",
  "重新检查并确认": "Recheck for confirmation",
  "原执行目标或目录已变化。请回到原环境，或让 AI 生成新的建议。": "The original target or directory changed. Return to the original environment or ask AI for a new suggestion.",
  "原终端需处于已验证、空闲且输入行为空的状态。请准备好后重试。": "The original terminal must be verified, idle, and have an empty input line. Prepare it and retry.",
  "此建议已处理，不能再次生成执行授权。": "This suggestion has already been handled and cannot be reauthorized.",
  "此建议已过期。请重新检查并确认。": "This suggestion expired. Recheck it before confirming.",
  "请在原终端取得写入权限后重试。": "Acquire the write lease in the original terminal and retry.",
  "原终端已不可用。请让 AI 为当前终端生成新的建议。": "The original terminal is unavailable. Ask AI for a new suggestion for the current terminal.",
  "上下文预览已过期，请检查刷新后的范围并重新发送。": "Context preview expired. Check the refreshed selection and send again.",
  "上下文预览暂时已达容量上限，请稍后刷新重试。": "Context preview capacity reached. Refresh and retry shortly.",
  "上下文不属于当前对话或终端，请重新选择。": "Context does not belong to this conversation or terminal. Select it again.",
  "当前对话仍在处理中，请稍后再发送。": "This conversation is still processing. Wait before sending again.",
  "本次请求已停止，附件未标记为发送成功。": "Request stopped. Attachments were not marked as successfully sent.",
  "正在连接本地 Core…": "Connecting to local Core…",
  "无法连接本地 Core。": "Unable to connect to local Core.",
  "重新连接": "Retry",
  "本地会话已失效": "The local session has expired.",
  "无法创建终端": "Unable to create the terminal.",
  "无法关闭终端": "Unable to close the terminal.",
  "正在创建终端": "Creating terminal…",
  "同一 Docker 目标 · 重新核验": "Same Docker target · reverify",
  "旧版恢复会话 · 请新建连接": "Restored legacy session · create a new connection",
  "旧版恢复的远程会话无法复制分栏，请新建连接。": "A restored legacy remote session cannot be duplicated. Create a new connection.",
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
  "终端操作": "Terminal actions",
  "解释最近输出": "Explain latest output",
  "修复最近命令": "Fix latest command",
  "附带最近命令和输出": "Attach the latest command and output",
  "生成固定到当前环境的建议": "Suggest a fix bound to this environment",
  "解释最近一条命令的输出，并告诉我是否正常。": "Explain the latest command output and tell me whether it is normal.",
  "分析最近一条命令为什么失败，并给出需要确认后执行的修复命令。": "Analyze why the latest command failed and suggest a fix that requires confirmation before running.",
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
  "正在连接 AI 提供方…": "Connecting to AI provider…",
  "AI 提供方": "AI provider",
  "新建对话后可切换提供方": "Start a new conversation to switch providers",
  "模型": "Model",
  "配置 DeepSeek": "Configure DeepSeek",
  "配置 DeepSeek API": "Configure DeepSeek API",
  "API Key 仅保存在本机，模型只能返回回答和待确认的命令建议。": "The API key stays on this computer. The model can only return answers and command suggestions that require confirmation.",
  "API 地址": "API endpoint",
  "留空以保留已保存的密钥": "Leave blank to keep the saved key",
  "密钥将发送到": "The key will be sent to",
  "当前仅在本次会话中保存。": "It is stored for this session only.",
  "密钥由 Windows 系统加密后保存。": "The key is stored with Windows system encryption.",
  "测试连接": "Test connection",
  "正在测试…": "Testing…",
  "连接成功": "Connection successful",
  "保存并使用": "Save and use",
  "正在保存…": "Saving…",
  "取消": "Cancel",
  "清除 DeepSeek 配置": "Clear DeepSeek configuration",
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
  "AI 正在分析当前终端…": "AI is analyzing the current terminal…",
  "问当前命令、输出或下一步…": "Ask about the current command, output, or next step…",
  "快速询问 AI": "Quick Ask AI",
  "询问当前终端": "Ask this terminal",
  "历史与详情": "History & details",
  "关闭快速询问": "Close Quick Ask",
  "Esc 返回终端": "Esc to return to terminal",
  "需要先使用 ChatGPT 登录": "Sign in with ChatGPT first",
  "需要先配置 AI 提供方": "Configure an AI provider first",
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
  "快速询问快捷键": "Quick Ask shortcut",
  "默认按 F8，也可以在设置中修改。中文输入法组合期间不会拦截快捷键。": "Press F8 by default, or change it in Settings. Shortcuts are never intercepted during input method composition.",
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
  "当前 AI 提供方不可用。": "The selected AI provider is unavailable.",
  "需要先配置 DeepSeek API Key。": "Configure a DeepSeek API key first.",
  "DeepSeek 拒绝了这个 API Key。": "DeepSeek rejected this API key.",
  "DeepSeek 请求频率受限，请稍后重试。": "DeepSeek rate limit reached. Try again later.",
  "DeepSeek 请求已停止。": "The DeepSeek request was stopped.",
  "DeepSeek 请求超时。": "The DeepSeek request timed out.",
  "无法连接 DeepSeek API。": "Unable to connect to the DeepSeek API.",
  "DeepSeek 返回了无效响应。": "DeepSeek returned an invalid response.",
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
