const TRAY_ICON_SIZES = [
  { size: 16, scaleFactor: 1 },
  { size: 20, scaleFactor: 1.25 },
  { size: 24, scaleFactor: 1.5 },
  { size: 32, scaleFactor: 2 },
];
const MENU_BAR_ICON = { height: 18, scaleFactors: [1, 2], minBlockWidth: 22, blockGap: 5 };
const MENU_BAR_FONT = '600 14px system-ui';
const MENU_BAR_AMBIENT_FONT = '600 12px system-ui';

let trayIconKey = '';

function drawTrayIcon(size, device, tint) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const ink = darkTaskbar ? '#f3f5f7' : '#14181c';
  context.fillStyle = ink;
  context.globalAlpha = device?.ligado ? 1 : 0.5;
  context.font = `600 condensed ${Math.round(size * 0.8)}px Bahnschrift`;
  context.textAlign = 'center';
  context.fillText(device?.temp == null ? '--' : String(device.temp), size / 2, Math.round(size * 0.76));
  if (device?.ligado) {
    const bar = Math.max(2, Math.round(size / 10));
    context.globalAlpha = 1;
    context.fillStyle = darkTaskbar ? tint : ink;
    context.fillRect(Math.round(size * 0.18), size - bar, Math.round(size * 0.64), bar);
  }
  return canvas.toDataURL('image/png');
}

/* macOS menu bar icon: a template image, so only the alpha channel matters and the system picks the colour. */

const measureContext = document.createElement('canvas').getContext('2d');

function textWidth(font, text) {
  measureContext.font = font;
  return Math.ceil(measureContext.measureText(text).width);
}

// A dimmed number reads as a disabled menu item, so "off" is a full-opacity power symbol instead.
function drawPowerSymbol(context, x, width) {
  const centerX = x + width / 2;
  const centerY = 9.6;
  const gap = 0.62;
  context.lineWidth = 1.8;
  context.lineCap = 'round';
  context.beginPath();
  context.arc(centerX, centerY, 5.1, -Math.PI / 2 + gap, (3 * Math.PI) / 2 - gap);
  context.stroke();
  context.beginPath();
  context.moveTo(centerX, centerY - 6.2);
  context.lineTo(centerX, centerY - 1.2);
  context.stroke();
}

function drawSetpoint(context, x, width, text, withBar) {
  context.font = MENU_BAR_FONT;
  context.textAlign = 'center';
  context.fillText(text, x + width / 2, 12);
  // The comma of "23,5" hangs below the baseline, so the bar sits a little lower than the digits need.
  if (withBar) context.fillRect(x + 4, 15.5, width - 8, 1.5);
}

function drawThermometer(context, centerX) {
  context.beginPath();
  context.roundRect(centerX - 1.2, 3, 2.4, 9.6, 1.2);
  context.fill();
  context.beginPath();
  context.arc(centerX, 12.6, 2.7, 0, Math.PI * 2);
  context.fill();
}

function setpointBlock(device) {
  if (device && !device.ligado) {
    const { minBlockWidth } = MENU_BAR_ICON;
    return { width: minBlockWidth, draw: (context, x) => drawPowerSymbol(context, x, minBlockWidth) };
  }
  const text = device ? formatTemp(device.temp) : '--';
  const width = Math.max(MENU_BAR_ICON.minBlockWidth, textWidth(MENU_BAR_FONT, text) + 4);
  return { width, draw: (context, x) => drawSetpoint(context, x, width, text, Boolean(device)) };
}

function ambientBlock(device) {
  const text = device.ambiente == null ? '--' : `${formatTemp(device.ambiente)}°`;
  const thermometerWidth = 5.4;
  const width = Math.ceil(thermometerWidth + 2 + textWidth(MENU_BAR_AMBIENT_FONT, text));
  return {
    width,
    draw(context, x) {
      drawThermometer(context, x + thermometerWidth / 2);
      context.font = MENU_BAR_AMBIENT_FONT;
      context.textAlign = 'left';
      context.fillText(text, x + thermometerWidth + 2, 12);
    },
  };
}

function drawMenuBarIcon(scaleFactor, device, showAmbient) {
  const blocks = [setpointBlock(device)];
  if (showAmbient && device) blocks.push(ambientBlock(device));
  const width = blocks.reduce((sum, block) => sum + block.width, 0) + MENU_BAR_ICON.blockGap * (blocks.length - 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scaleFactor);
  canvas.height = MENU_BAR_ICON.height * scaleFactor;
  const context = canvas.getContext('2d');
  context.scale(scaleFactor, scaleFactor);
  let x = 0;
  for (const block of blocks) {
    block.draw(context, x);
    x += block.width + MENU_BAR_ICON.blockGap;
  }
  return canvas.toDataURL('image/png');
}

function renderTrayIcon() {
  // Signed out, the last reading is stale, so the menu bar shows "--" instead of it.
  const device = IS_MAC && loggedOut() ? null : view?.device;
  const showAmbient = IS_MAC && settings.icone.ambiente;
  const ambient = showAmbient ? device?.ambiente : '';
  const key = [device?.temp, device?.ligado, device?.modo, ambient, showAmbient, darkTaskbar, activeLocale].join('|');
  if (key === trayIconKey) return;
  trayIconKey = key;
  if (IS_MAC) {
    window.ac.setTrayIcon(
      MENU_BAR_ICON.scaleFactors.map((scaleFactor) => ({
        scaleFactor,
        dataURL: drawMenuBarIcon(scaleFactor, device, showAmbient),
      })),
    );
    return;
  }
  const tint = getComputedStyle(panel).getPropertyValue('--tint').trim();
  window.ac.setTrayIcon(
    TRAY_ICON_SIZES.map(({ size, scaleFactor }) => ({ scaleFactor, dataURL: drawTrayIcon(size, device, tint) })),
  );
}
