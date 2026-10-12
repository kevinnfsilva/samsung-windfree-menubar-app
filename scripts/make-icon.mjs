// Regenerates build/icon.png and build/icon.icns from build/icon.svg.
// Usage: node scripts/make-icon.mjs   (macOS only: needs the project's Electron and iconutil)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Under Node this is the path of the Electron binary; inside Electron it is the API.
import electron from 'electron';

const SELF = fileURLToPath(import.meta.url);
const BUILD = path.join(path.dirname(SELF), '..', 'build');
// Pixel size of every entry of a macOS iconset.
const ICONSET = {
  'icon_16x16.png': 16,
  'icon_16x16@2x.png': 32,
  'icon_32x32.png': 32,
  'icon_32x32@2x.png': 64,
  'icon_128x128.png': 128,
  'icon_128x128@2x.png': 256,
  'icon_256x256.png': 256,
  'icon_256x256@2x.png': 512,
  'icon_512x512.png': 512,
  'icon_512x512@2x.png': 1024,
};

if (typeof electron === 'string') {
  buildIcon();
} else {
  renderSizes(process.argv.at(-1));
}

// Node side: has Electron draw every size into a temporary folder, then packs them with iconutil.
function buildIcon() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'windfree-icon-'));
  try {
    // With ELECTRON_RUN_AS_NODE set, the child would be plain Node and land in this branch again.
    const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
    execFileSync(electron, [SELF, work], { env, stdio: 'inherit', timeout: 60_000 });

    const iconset = path.join(work, 'icon.iconset');
    fs.mkdirSync(iconset);
    for (const [name, size] of Object.entries(ICONSET)) {
      fs.copyFileSync(path.join(work, `${size}.png`), path.join(iconset, name));
    }
    fs.copyFileSync(path.join(work, '1024.png'), path.join(BUILD, 'icon.png'));
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD, 'icon.icns')]);
    console.log('Wrote build/icon.png and build/icon.icns');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Electron side: draws the SVG once per size in a hidden offscreen window and saves <size>.png into `work`.
// Each size is rasterised from the vectors, and the SVG swaps in simpler artwork at 32 px and below.
function renderSizes(work) {
  const { app, BrowserWindow } = electron;
  app.dock?.hide();
  app.setPath('userData', path.join(work, 'electron'));
  // Software rasterisation antialiases exactly; the GPU path dithers edges, which shows at 16 px.
  app.disableHardwareAcceleration();

  app.whenReady().then(async () => {
    try {
      for (const size of new Set(Object.values(ICONSET))) {
        const window = new BrowserWindow({
          width: size,
          height: size,
          show: false,
          frame: false,
          transparent: true,
          webPreferences: { offscreen: { deviceScaleFactor: 1 } },
        });
        await window.loadFile(path.join(BUILD, 'icon.svg'));
        // The SVG declares 1024 x 1024; stretch it to the window and wait for that layout to be painted.
        await window.webContents.insertCSS(':root { width: 100vw; height: 100vh; }');
        await window.webContents.executeJavaScript('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
        const image = await window.webContents.capturePage();
        const { width, height } = image.getSize();
        if (width !== size || height !== size) throw new Error(`Expected ${size} px, captured ${width} x ${height}`);
        fs.writeFileSync(path.join(work, `${size}.png`), image.toPNG());
      }
      // Windows stay open until here: closing the last one would quit the app mid-loop.
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
