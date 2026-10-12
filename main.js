const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, nativeTheme, powerMonitor, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { AcBridge } = require('./bridge');

const IS_MAC = process.platform === 'darwin';
// The window leaves room around the panel for its shadow; on macOS the top margin is thinner so it hugs the menu bar.
const PANEL_SIZE = { width: 412, height: IS_MAC ? 522 : 536 };
const POLL_VISIBLE_MS = 15_000;
const POLL_HIDDEN_MS = 60_000;
const STALE_AFTER_MS = 5_000;
const REOPEN_GUARD_MS = 300;
const LOGIN_ITEM_NAME = 'WindFree';
const LAUNCH_AGENT_LABEL = 'io.github.kevinnfsilva.windfree';
const AUTOSTART_LABEL = IS_MAC ? 'Abrir com o macOS' : 'Abrir com o Windows';

const bridge = new AcBridge();
let tray;
let panel;
let pollTimer;
let lastBlurAt = 0;
let menuPowerState;
let contextMenu;

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function isAutostartEnabled() {
  return readSettings().autostart ?? true;
}

function launchAgentFile() {
  return path.join(app.getPath('home'), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

function plistString(value) {
  const escaped = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<string>${escaped}</string>`;
}

// macOS login items can't carry the app folder argument the unpackaged app needs, so a LaunchAgent starts it at login.
// The packaged app goes the same way to keep a single mechanism.
function setLaunchAgent(enabled) {
  const file = launchAgentFile();
  if (!enabled) {
    fs.rmSync(file, { force: true });
    return;
  }
  // Run from the disk image, or from the random path Gatekeeper gives a fresh download, the app is gone by next login.
  if (/^\/Volumes\/|\/AppTranslocation\//.test(process.execPath)) return;
  const programArguments = app.isPackaged ? [process.execPath] : [process.execPath, app.getAppPath()];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${plistString(LAUNCH_AGENT_LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${programArguments.map(plistString).join('\n    ')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
`;
  // Rewriting an identical file would make macOS announce the background item again on every launch.
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === plist) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, plist);
}

// Unpackaged, electron.exe needs the app folder as an argument or it boots the default app.
function setAutostart(enabled) {
  fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), autostart: enabled }));
  if (IS_MAC) {
    setLaunchAgent(enabled);
  } else {
    const launch = app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] };
    app.setLoginItemSettings({ openAtLogin: enabled, name: LOGIN_ITEM_NAME, ...launch });
  }
  updateMenu(true);
}

function taskbarIsDark() {
  return nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ?? nativeTheme.shouldUseDarkColors;
}

function createPanel() {
  const panelWindow = new BrowserWindow({
    ...PANEL_SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    ...(IS_MAC ? {} : { type: 'toolbar' }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (IS_MAC) {
    panelWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }
  panelWindow.loadFile(path.join(__dirname, 'panel', 'index.html'));
  panelWindow.on('blur', () => {
    lastBlurAt = Date.now();
    hidePanel();
  });
  return panelWindow;
}

// The panel rises from the Windows taskbar and drops from the macOS menu bar.
function positionPanel() {
  const trayBounds = tray.getBounds();
  const anchor = { x: trayBounds.x + trayBounds.width / 2, y: trayBounds.y };
  const { workArea } = screen.getDisplayNearestPoint(anchor);
  const [width, height] = panel.getSize();
  const rightmost = workArea.x + workArea.width - width;
  const centered = trayBounds.width > 0 ? Math.round(anchor.x - width / 2) : rightmost;
  const y = IS_MAC ? Math.max(workArea.y, trayBounds.y + trayBounds.height) : workArea.y + workArea.height - height;
  panel.setPosition(Math.max(workArea.x, Math.min(centered, rightmost)), y);
}

function showPanel() {
  positionPanel();
  panel.webContents.send('panel:show');
  panel.show();
  panel.focus();
  if (Date.now() - (bridge.updatedAt ?? 0) > STALE_AFTER_MS) bridge.refresh();
  schedulePoll();
}

function hidePanel() {
  if (!panel.isVisible()) return;
  panel.hide();
  // Otherwise macOS keeps the now windowless app in front and the keyboard goes nowhere.
  if (IS_MAC) app.hide();
  panel.webContents.send('panel:hide');
  schedulePoll();
}

// Clicking the tray icon blurs an open panel first, so a click right after a blur means "close", not "reopen".
function togglePanel() {
  if (panel.isVisible()) {
    hidePanel();
    return;
  }
  if (Date.now() - lastBlurAt < REOPEN_GUARD_MS) return;
  showPanel();
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const delay = panel.isVisible() ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
  pollTimer = setTimeout(() => {
    bridge.refresh();
    schedulePoll();
  }, delay);
}

function tooltipFor({ device }) {
  if (!device) return 'WindFree';
  const power = device.ligado ? `ligado em ${device.temp} °C` : 'desligado';
  return `${device.nome ?? 'Ar-condicionado'} ${power}\nAmbiente com ${device.ambiente} °C e ${device.umidade}% de umidade`;
}

function updateMenu(force = false) {
  const { device } = bridge.view();
  const powerState = device?.ligado;
  if (!force && powerState === menuPowerState) return;
  menuPowerState = powerState;
  contextMenu = Menu.buildFromTemplate([
    { label: 'Abrir painel', click: showPanel },
    {
      label: powerState ? 'Desligar' : 'Ligar',
      enabled: Boolean(device),
      click: () => bridge.set('ligado', !powerState),
    },
    { label: 'Atualizar agora', click: () => bridge.refresh() },
    { type: 'separator' },
    {
      label: AUTOSTART_LABEL,
      type: 'checkbox',
      checked: isAutostartEnabled(),
      click: (item) => setAutostart(item.checked),
    },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ]);
  // A menu attached to a macOS status item takes over the left click, so there it only pops up on right-click.
  if (!IS_MAC) tray.setContextMenu(contextMenu);
}

// As a template image, macOS repaints the icon to suit whatever sits behind the menu bar.
function trayImage(images) {
  const image = nativeImage.createEmpty();
  for (const { scaleFactor, dataURL } of images) image.addRepresentation({ scaleFactor, dataURL });
  if (IS_MAC) image.setTemplateImage(true);
  return image;
}

function start() {
  // Writing inside the app bundle would break its code signature, so device.json goes next to the settings.
  if (app.isPackaged) process.env.WINDFREE_DATA_DIR = app.getPath('userData');
  if (IS_MAC) {
    app.dock.hide();
    // The default menu's shortcuts would let Cmd+W destroy the panel.
    Menu.setApplicationMenu(null);
  }
  panel = createPanel();
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('WindFree');
  tray.on('click', togglePanel);
  if (IS_MAC) {
    tray.setIgnoreDoubleClickEvents(true);
    tray.on('right-click', () => tray.popUpContextMenu(contextMenu));
  }
  updateMenu(true);
  setAutostart(isAutostartEnabled());

  bridge.on('change', (view) => {
    panel.webContents.send('state', view);
    tray.setToolTip(tooltipFor(view));
    updateMenu();
  });

  ipcMain.handle('state:get', () => ({ view: bridge.view(), darkTaskbar: taskbarIsDark() }));
  ipcMain.handle('autostart:get', isAutostartEnabled);
  ipcMain.on('autostart:set', (_event, enabled) => setAutostart(enabled));
  ipcMain.on('ac:set', (_event, key, value) => bridge.set(key, value));
  ipcMain.on('ac:refresh', () => bridge.refresh());
  ipcMain.on('panel:hide', hidePanel);
  ipcMain.on('tray:icon', (_event, images) => tray.setImage(trayImage(images)));

  nativeTheme.on('updated', () => panel.webContents.send('theme', taskbarIsDark()));
  powerMonitor.on('resume', () => bridge.refresh());
  app.on('second-instance', showPanel);

  bridge.refresh();
  schedulePoll();
}

if (app.requestSingleInstanceLock()) {
  app.whenReady().then(start);
} else {
  app.quit();
}
