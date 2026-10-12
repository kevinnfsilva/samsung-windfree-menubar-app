const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, nativeTheme, powerMonitor, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { AcBridge } = require('./bridge');
const { appMenuTemplate } = require('./lib/app-menu');
const { isValidAction, isValidChange } = require('./lib/commands');
const { Favorites } = require('./lib/favorites');
const { History } = require('./lib/history');
const { createI18n, resolveLanguage } = require('./lib/i18n');
const { Notifier } = require('./lib/notifications');
const { Scheduler } = require('./lib/scheduler');
const { SettingsStore } = require('./lib/settings');
const { Shortcut } = require('./lib/shortcut');
const { menuTemplate, tooltipFor } = require('./lib/tray-menu');
const { UpdateChecker } = require('./lib/updates');
const { repository } = require('./package.json');

const IS_MAC = process.platform === 'darwin';
// The window leaves room around the panel for its shadow; on macOS the top margin is thinner so it hugs the menu bar.
const PANEL_SIZE = { width: 412, height: IS_MAC ? 522 : 536 };
const POLL_VISIBLE_MS = 15_000;
const POLL_HIDDEN_MS = 60_000;
const STALE_AFTER_MS = 5_000;
const REOPEN_GUARD_MS = 300;
const TRAY_SETTLE_MS = 100;
const QUIT_GRACE_MS = 3_000;
const QUIT_POLL_MS = 100;
const LOGIN_ITEM_NAME = 'WindFree';
const LAUNCH_AGENT_LABEL = 'io.github.kevinnfsilva.windfree';

const bridge = new AcBridge();
let settings;
let history;
let favorites;
let scheduler;
let notifier;
let shortcut;
let updates;
let i18n;
let tray;
let panel;
let pollTimer;
let lastBlurAt = 0;
let menuKey;
let contextMenu;
let quitting = false;

function isAutostartEnabled() {
  return settings.get().autostart;
}

function launchAgentFile() {
  return path.join(app.getPath('home'), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

function isWritable(file) {
  try {
    fs.accessSync(file, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
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
  const onDiskImage = process.execPath.startsWith('/Volumes/') && !isWritable(process.execPath);
  if (onDiskImage || process.execPath.includes('/AppTranslocation/')) return;
  // The trailing flag tells the launch at login from one the user asked for, which opens the panel.
  const programArguments = [...(app.isPackaged ? [process.execPath] : [process.execPath, app.getAppPath()]), '--hidden'];
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
  // launchd refuses agents that others can write to.
  fs.writeFileSync(file, plist, { mode: 0o644 });
}

// Applies the setting to the system; the setting itself is saved by the settings store.
function setAutostart(enabled) {
  if (IS_MAC) {
    try {
      setLaunchAgent(enabled);
    } catch (error) {
      // A LaunchAgents folder the user can't write to must not keep the app from starting.
      console.error(error);
    }
  } else {
    // Unpackaged, electron.exe needs the app folder as an argument or it boots the default app.
    const launch = app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] };
    app.setLoginItemSettings({ openAtLogin: enabled, name: LOGIN_ITEM_NAME, ...launch });
  }
  updateMenu(true);
}

// The Dock icon and the menu bar that comes with it go together; without them the app lives in the tray alone.
function applyDock(enabled) {
  if (enabled) {
    app.dock.show().catch(console.error);
    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(app.name)));
  } else {
    app.dock.hide();
    // The default menu's shortcuts would let Cmd+W destroy the panel.
    Menu.setApplicationMenu(null);
  }
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

// A status item takes a moment to move after its icon changes width, and the open panel hangs from its middle.
function placePanelWhenSettled() {
  setTimeout(positionPanel, TRAY_SETTLE_MS);
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
    // Without a session, or after a timeout, a poll would only fail again; the user retries by hand.
    if (!bridge.paused) bridge.refresh();
    schedulePoll();
  }, delay);
}

function updateMenu(force = false) {
  const view = bridge.view();
  const { favoritos } = settings.get();
  const autostart = isAutostartEnabled();
  const update = updates.notice;
  const key = JSON.stringify([view.device?.ligado, Boolean(view.device), view.login, favoritos.map(({ id, nome }) => [id, nome]), autostart, update?.versao, i18n.language]);
  if (!force && key === menuKey) return;
  menuKey = key;
  contextMenu = Menu.buildFromTemplate(
    menuTemplate({
      view,
      favoritos,
      autostart,
      update,
      i18n,
      actions: {
        showPanel,
        openUpdate,
        login: () => bridge.login(),
        cancelLogin: () => bridge.cancelLogin(),
        setPower: (on) => setByHand('ligado', on),
        applyFavorite: applyFavoriteByHand,
        refresh: () => bridge.refresh(),
        setAutostart: (enabled) => settings.update({ autostart: enabled }),
        quit: () => app.quit(),
      },
    }),
  );
  // A menu attached to a macOS status item takes over the left click, so there it only pops up on right-click.
  if (!IS_MAC) tray.setContextMenu(contextMenu);
}

// What the user does by hand wins over a scheduled command that is still being retried for the same unit.
function setByHand(key, value) {
  if (!isValidChange(key, value)) return;
  if (key === 'ligado') scheduler.cancelRetries(bridge.view().device?.id);
  bridge.set(key, value);
}

function applyFavoriteByHand(id) {
  scheduler.cancelRetries(bridge.view().device?.id);
  return favorites.apply(id);
}

// A change made a moment ago may still be waiting to go out or be on its way; the bridge would kill it on the way out.
function commandsOnTheWay() {
  return bridge.view().syncing || scheduler.busy;
}

async function openUpdate() {
  const url = updates.downloadPage();
  if (!url) return;
  try {
    await shell.openExternal(url);
  } catch (error) {
    console.error(error);
  }
}

function languageSetting() {
  return resolveLanguage(settings.get().idioma, app.getLocale());
}

// The tray menu and tooltip are rebuilt here; the panel redraws itself when it hears about the new language.
function applyLanguage() {
  const language = languageSetting();
  if (language === i18n.language) return;
  i18n = createI18n(language);
  panel.webContents.send('locale', language);
  tray.setToolTip(tooltipFor(bridge.view(), i18n));
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
  // Windows ties notifications to this id.
  if (!IS_MAC) app.setAppUserModelId(LAUNCH_AGENT_LABEL);

  shortcut = new Shortcut(togglePanel);
  settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'), {
    // A key another app already owns can't be registered, so the setting turns itself off instead of lying.
    adjust: (next) => {
      if (!shortcut.apply(next.atalho)) next.atalho.ativo = false;
    },
  });
  // Registered before anything else listens, so the panel hears every change in order even when a later listener changes settings in turn.
  settings.on('change', (next, previous) => {
    panel.webContents.send('settings', next);
    if (next.idioma !== previous.idioma) applyLanguage();
    if (next.autostart !== previous.autostart) setAutostart(next.autostart);
    if (IS_MAC && next.dock !== previous.dock) applyDock(next.dock);
    if (next.atualizacoes !== previous.atualizacoes) updates.setEnabled(next.atualizacoes);
    updateMenu();
  });
  i18n = createI18n(languageSetting());
  updates = new UpdateChecker({ repository, version: app.getVersion() });
  if (IS_MAC) applyDock(settings.get().dock);
  history = new History(path.join(app.getPath('userData'), 'historico.json'));
  favorites = new Favorites({ settings, bridge });
  notifier = new Notifier({ settings, bridge, onClick: showPanel, i18n: () => i18n });
  scheduler = new Scheduler({
    settings,
    bridge,
    favorites,
    notify: (aparelho, key) => notifier.alert(aparelho.nome, key),
    file: path.join(app.getPath('userData'), 'pendentes.json'),
  });

  panel = createPanel();
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('WindFree');
  tray.on('click', togglePanel);
  if (IS_MAC) {
    tray.setIgnoreDoubleClickEvents(true);
    tray.on('right-click', () => tray.popUpContextMenu(contextMenu));
  }
  // An empty update registers a shortcut saved as active, and turns the setting off when the key is no longer free.
  settings.update({});
  updateMenu(true);
  setAutostart(isAutostartEnabled());

  bridge.on('change', (view) => {
    panel.webContents.send('state', view);
    tray.setToolTip(tooltipFor(view, i18n));
    updateMenu();
    history.record(view);
    notifier.check(view);
  });
  updates.on('change', (notice) => {
    panel.webContents.send('update', notice);
    updateMenu();
  });

  ipcMain.handle('state:get', () => ({ view: bridge.view(), darkTaskbar: taskbarIsDark(), settings: settings.get(), locale: i18n.language, update: updates.notice }));
  ipcMain.handle('autostart:get', isAutostartEnabled);
  ipcMain.on('autostart:set', (_event, enabled) => settings.update({ autostart: enabled }));
  ipcMain.on('ac:set', (_event, key, value) => setByHand(key, value));
  ipcMain.on('ac:refresh', () => bridge.refresh());
  ipcMain.on('ac:login', () => bridge.login());
  ipcMain.on('ac:cancel-login', () => bridge.cancelLogin());
  ipcMain.on('ac:list-devices', () => bridge.listDevices());
  ipcMain.on('ac:use-device', (_event, id) => {
    if (typeof id === 'string') bridge.useDevice(id);
  });
  ipcMain.on('ac:run', (_event, action) => {
    if (isValidAction(action)) bridge.run(action);
  });
  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:update', (_event, patch) => settings.update(patch));
  ipcMain.handle('favorite:save', (_event, nome) => favorites.save(nome));
  ipcMain.handle('favorite:apply', (_event, id) => applyFavoriteByHand(id));
  ipcMain.handle('favorite:delete', (_event, id) => favorites.remove(id));
  ipcMain.handle('timer:set', (_event, acao, minutos) => scheduler.setTimer(acao, minutos));
  ipcMain.handle('timer:clear', () => scheduler.clearTimer());
  ipcMain.handle('schedule:save', (_event, agenda) => scheduler.saveSchedule(agenda));
  ipcMain.handle('schedule:delete', (_event, id) => scheduler.deleteSchedule(id));
  ipcMain.handle('history:get', () => history.get(bridge.view().device?.id));
  ipcMain.on('update:open', openUpdate);
  ipcMain.on('panel:hide', hidePanel);
  ipcMain.on('tray:icon', (_event, images) => {
    const { width } = tray.getBounds();
    tray.setImage(trayImage(images));
    if (panel.isVisible() && tray.getBounds().width !== width) placePanelWhenSettled();
  });

  nativeTheme.on('updated', () => panel.webContents.send('theme', taskbarIsDark()));
  powerMonitor.on('resume', () => {
    if (!bridge.paused) bridge.refresh();
    scheduler.check();
    updates.resume();
  });
  app.on('second-instance', showPanel);
  // Opening the app again from Finder is the way in when the menu bar has no room for the icon.
  if (IS_MAC) app.on('activate', showPanel);
  app.on('before-quit', (event) => {
    if (quitting || !commandsOnTheWay()) return;
    // Quitting is put off for a moment, never longer than the grace period, so that the change still goes out.
    event.preventDefault();
    quitting = true;
    const deadline = Date.now() + QUIT_GRACE_MS;
    const wait = setInterval(() => {
      if (commandsOnTheWay() && Date.now() < deadline) return;
      clearInterval(wait);
      app.quit();
    }, QUIT_POLL_MS);
  });
  app.on('will-quit', () => {
    scheduler.stop();
    notifier.stop();
    updates.stop();
    shortcut.dispose();
    history.flush();
    bridge.dispose();
  });

  // Opened by hand, the panel greets the user; the LaunchAgent passes --hidden so that a login stays quiet.
  if (IS_MAC && !process.argv.includes('--hidden')) {
    panel.webContents.once('did-finish-load', () => {
      showPanel();
      // The tray icon is still being drawn at this point.
      placePanelWhenSettled();
    });
  }

  bridge.refresh();
  schedulePoll();
  scheduler.start();
  notifier.start();
  updates.start(settings.get().atualizacoes);
}

if (app.requestSingleInstanceLock()) {
  app.whenReady().then(start);
} else {
  app.quit();
}
