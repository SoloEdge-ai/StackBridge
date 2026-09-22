import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  safeStorage,
  shell,
} from "electron";

import { detectCodexCli } from "./codex-cli.js";
import { matchesDesktopShortcut } from "./desktop-shortcuts.js";

const toggleQuickAskChannel = "stackbridge:toggle-quick-ask";
const setQuickAskShortcutChannel = "stackbridge:set-quick-ask-shortcut";
const setCompositionActiveChannel = "stackbridge:set-composition-active";
const maximumShortcutLength = 64;

app.setName("StackBridge");
app.setPath(
  "userData",
  process.env.STACKBRIDGE_USER_DATA_DIR
    ? resolve(process.env.STACKBRIDGE_USER_DATA_DIR)
    : join(app.getPath("appData"), "StackBridge"),
);

const gotSingleInstanceLock = app.requestSingleInstanceLock();
let mainWindow: BrowserWindow | undefined;
let quickAskShortcut = "F8";
let registeredQuickAskShortcut: string | undefined;
let compositionActive = false;

ipcMain.on(setQuickAskShortcutChannel, (event, value: unknown) => {
  if (event.sender !== mainWindow?.webContents) return;
  if (typeof value !== "string" || value.length === 0 || value.length > maximumShortcutLength) return;
  quickAskShortcut = value;
  registerQuickAskGlobalShortcut();
});

ipcMain.on(setCompositionActiveChannel, (event, value: unknown) => {
  if (event.sender !== mainWindow?.webContents || typeof value !== "boolean") return;
  compositionActive = value;
  if (compositionActive) unregisterQuickAskGlobalShortcut();
  else registerQuickAskGlobalShortcut();
});

app.on("will-quit", unregisterQuickAskGlobalShortcut);

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow === undefined) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on("window-all-closed", () => app.quit());
  void startDesktop().catch((error: unknown) => {
    const diagnostic = error instanceof Error ? error.stack ?? error.message : String(error);
    const message = error instanceof Error ? error.message : String(error);
    console.error(diagnostic);
    dialog.showErrorBox("StackBridge could not start", message);
    app.quit();
  });
}

async function startDesktop(): Promise<void> {
  await app.whenReady();
  app.setAppUserModelId("ai.soloedge.stackbridge");
  Menu.setApplicationMenu(null);

  const detectedCodex = await detectCodexCli();
  if (detectedCodex.available) {
    process.env.STACKBRIDGE_CODEX_BIN = detectedCodex.codex.command;
    process.env.STACKBRIDGE_CODEX_ARG_PREFIX = JSON.stringify(detectedCodex.codex.argumentPrefix);
    delete process.env.STACKBRIDGE_CODEX_DISABLED;
    console.log(`Using system Codex CLI: ${detectedCodex.codex.version} (${detectedCodex.codex.resolvedPath})`);
  } else {
    delete process.env.STACKBRIDGE_CODEX_BIN;
    delete process.env.STACKBRIDGE_CODEX_ARG_PREFIX;
    process.env.STACKBRIDGE_CODEX_DISABLED = "1";
    console.warn(`ChatGPT provider unavailable: ${detectedCodex.error}`);
  }
  installDesktopSecretProtector();

  const port = await availableLoopbackPort();
  const workbenchUrl = `http://127.0.0.1:${port}`;
  configureCore(port, workbenchUrl);

  const coreEntry = new URL("./core.js", import.meta.url).href;
  await import(coreEntry);
  const preloadPath = join(dirname(fileURLToPath(import.meta.url)), "preload.cjs");

  mainWindow = new BrowserWindow({
    title: "StackBridge",
    width: 1_440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: "#09090d",
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#111116",
      symbolColor: "#9a9aa6",
      height: 38,
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (!matchesDesktopShortcut(input, quickAskShortcut)) return;
    event.preventDefault();
    mainWindow?.webContents.send(toggleQuickAskChannel);
  });
  mainWindow.on("focus", registerQuickAskGlobalShortcut);
  mainWindow.on("blur", unregisterQuickAskGlobalShortcut);

  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(`${workbenchUrl}/`) || url === workbenchUrl) return;
    event.preventDefault();
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    unregisterQuickAskGlobalShortcut();
    mainWindow = undefined;
  });

  await mainWindow.loadURL(`${workbenchUrl}/?desktop=1`);
}

function installDesktopSecretProtector(): void {
  const key = Symbol.for("stackbridge.secretProtector");
  const target = globalThis as typeof globalThis & Record<symbol, unknown>;
  target[key] = safeStorage.isEncryptionAvailable()
    ? {
        persistence: "system-encrypted" as const,
        protect(value: string): string {
          return safeStorage.encryptString(value).toString("base64");
        },
        unprotect(value: string): string {
          return safeStorage.decryptString(Buffer.from(value, "base64"));
        },
      }
    : undefined;
}

function registerQuickAskGlobalShortcut(): void {
  unregisterQuickAskGlobalShortcut();
  const window = mainWindow;
  if (window === undefined || !window.isFocused() || compositionActive) return;
  try {
    const registered = globalShortcut.register(quickAskShortcut, () => {
      if (mainWindow?.isFocused()) mainWindow.webContents.send(toggleQuickAskChannel);
    });
    if (registered) registeredQuickAskShortcut = quickAskShortcut;
    else console.warn(`Could not register Quick Ask shortcut: ${quickAskShortcut}`);
  } catch (error) {
    console.warn(`Invalid Quick Ask shortcut: ${quickAskShortcut}`, error);
  }
}

function unregisterQuickAskGlobalShortcut(): void {
  if (registeredQuickAskShortcut === undefined) return;
  globalShortcut.unregister(registeredQuickAskShortcut);
  registeredQuickAskShortcut = undefined;
}

function configureCore(port: number, workbenchUrl: string): void {
  const resourcesRoot = app.isPackaged ? process.resourcesPath : resolve(app.getAppPath(), "../..");
  process.env.STACKBRIDGE_CORE_PORT = String(port);
  process.env.STACKBRIDGE_ALLOWED_ORIGINS = workbenchUrl;
  process.env.STACKBRIDGE_TERMINAL_CWD = app.getPath("home");
  process.env.STACKBRIDGE_WEB_DIST_DIR = app.isPackaged
    ? join(resourcesRoot, "web")
    : join(resourcesRoot, "apps", "web", "dist");
  process.env.STACKBRIDGE_RUNTIME_MANIFEST = join(resourcesRoot, "runtime", "bin", "manifest.json");
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveReady());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("无法分配本地服务端口");
  }
  await new Promise<void>((resolveClosed, reject) => {
    server.close((error) => error === undefined ? resolveClosed() : reject(error));
  });
  return address.port;
}
