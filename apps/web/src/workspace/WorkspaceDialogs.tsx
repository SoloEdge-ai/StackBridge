import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { CreateTerminalSessionRequest } from "@stackbridge/protocol";
import { DeploymentRequired, errorMessage } from "../api/client.js";
import { useLanguage } from "../i18n.js";

export function ConnectionDialog({ onClose, onCreate }: {
  onClose(): void;
  onCreate(request: CreateTerminalSessionRequest, title: string, kind: "ssh" | "docker"): Promise<void>;
}) {
  const { t } = useLanguage();
  const [kind, setKind] = useState<"ssh" | "docker">("ssh");
  const [host, setHost] = useState("friden-dev-cube");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("friden");
  const [container, setContainer] = useState("stackbridge-m0b1-ubuntu22");
  const [containerUser, setContainerUser] = useState("root");
  const [cwd, setCwd] = useState("/workspace");
  const [contextName, setContextName] = useState("default");
  const [approval, setApproval] = useState<{ id: string; proposal: Record<string, unknown> }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const request = useMemo(() => kind === "ssh" ? {
    kind, cols: 120, rows: 32, host, port: Number(port), user,
  } : {
    kind, cols: 120, rows: 32, host, port: Number(port), user,
    contextName, container, containerUser, cwd,
  }, [container, containerUser, contextName, cwd, host, kind, port, user]);

  async function submit(event?: FormEvent, deploymentApprovalId?: string) {
    event?.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await onCreate(
        { ...request, ...(deploymentApprovalId ? { deploymentApprovalId } : {}) },
        kind === "ssh" ? `${user}@${host}` : `Docker · ${container}`,
        kind,
      );
    } catch (reason) {
      if (reason instanceof DeploymentRequired) {
        setApproval({ id: String(reason.payload.approvalId), proposal: reason.payload.proposal as Record<string, unknown> });
      } else setError(errorMessage(reason, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t("新建连接")} onClose={onClose}>
      <div className="segmented">
        <button className={kind === "ssh" ? "active" : ""} onClick={() => setKind("ssh")}>{t("SSH 宿主")}</button>
        <button className={kind === "docker" ? "active" : ""} onClick={() => setKind("docker")}>{t("远端 Docker")}</button>
      </div>
      <form className="connection-form" onSubmit={(event) => void submit(event)}>
        <div className="field-grid three">
          <Field label={t("主机")}><input value={host} onChange={(event) => setHost(event.target.value)} required /></Field>
          <Field label={t("端口")}><input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" required /></Field>
          <Field label={t("用户")}><input value={user} onChange={(event) => setUser(event.target.value)} required /></Field>
        </div>
        {kind === "docker" ? <>
          <Field label={t("容器名称或 ID")}><input value={container} onChange={(event) => setContainer(event.target.value)} required /></Field>
          <div className="field-grid three">
            <Field label="Docker Context"><input value={contextName} onChange={(event) => setContextName(event.target.value)} required /></Field>
            <Field label={t("容器用户")}><input value={containerUser} onChange={(event) => setContainerUser(event.target.value)} required /></Field>
            <Field label={t("工作目录")}><input value={cwd} onChange={(event) => setCwd(event.target.value)} required /></Field>
          </div>
        </> : null}
        <p className="form-note">{t("使用系统 OpenSSH 配置和密钥。Core 会先核验主机与运行实例，再打开真实交互 PTY。")}</p>
        {approval ? (
          <div className="approval-box">
            <strong>{t("需要部署远端 Runtime")}</strong>
            <p>{t("将固定版本运行时安装到登录用户的 ~/.sbridge。不会修改系统目录或 Shell 配置。")}</p>
            <dl>{Object.entries(approval.proposal).slice(0, 8).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void submit(undefined, approval.id)}>{t("确认部署并连接")}</button>
          </div>
        ) : <button className="primary-button" disabled={busy}>{busy ? t("正在核验…") : t("连接")}</button>}
        {error ? <p className="form-error">{error}</p> : null}
      </form>
    </Modal>
  );
}

export function SettingsDialog({ shortcut, locale, onLocaleChange, onSave, onClose }: {
  shortcut: string;
  locale: "en" | "zh-CN";
  onLocaleChange(locale: "en" | "zh-CN"): Promise<void>;
  onSave(value: string): void;
  onClose(): void;
}) {
  const { t } = useLanguage();
  const [value, setValue] = useState(shortcut);
  const [savingLanguage, setSavingLanguage] = useState(false);
  const [languageError, setLanguageError] = useState<string>();
  return (
    <Modal title={t("工作台设置")} onClose={onClose}>
      <Field label={t("语言")}>
        <select value={locale} disabled={savingLanguage} onChange={(event) => {
          const next = event.target.value as "en" | "zh-CN";
          setSavingLanguage(true);
          setLanguageError(undefined);
          void onLocaleChange(next)
            .catch(() => setLanguageError(t("无法保存语言设置。")))
            .finally(() => setSavingLanguage(false));
        }}>
          <option value="en">English</option>
          <option value="zh-CN">简体中文</option>
        </select>
      </Field>
      {languageError ? <p className="form-error">{languageError}</p> : null}
      <Field label={t("快速询问快捷键")}><input value={value} onChange={(event) => setValue(event.target.value)} /></Field>
      <p className="form-note">{t("默认按 F8，也可以在设置中修改。中文输入法组合期间不会拦截快捷键。")}</p>
      <button className="primary-button" onClick={() => onSave(value)}>{t("保存")}</button>
    </Modal>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card"><header><h2>{title}</h2><button className="icon-button" onClick={onClose}>×</button></header>{children}</section></div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}
