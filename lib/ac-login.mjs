import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROFILE = process.env.SMARTTHINGS_PROFILE ?? 'default';
const API_HOST = 'api.smartthings.com';
// The CLI refreshes its token when less than an hour is left on it.
const REFRESH_WINDOW_MS = 60 * 60_000;

export const OPEN_SHIM_DIR = fileURLToPath(new URL('./bin', import.meta.url));

// Same folders the CLI gets from env-paths('@smartthings/cli', { suffix: '' }), so the login is looked up where it was saved.
function cliDirs() {
  const home = os.homedir();
  const name = path.join('@smartthings', 'cli');
  if (process.platform === 'darwin') {
    return {
      config: path.join(home, 'Library', 'Preferences', name),
      data: path.join(home, 'Library', 'Application Support', name),
    };
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return { config: path.join(appData, name, 'Config'), data: path.join(localAppData, name, 'Data') };
  }
  return {
    config: path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), name),
    data: path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), name),
  };
}

// saved is true or false when the CLI's credentials file settles it, and null when the CLI may sign in some other way.
export function loginState() {
  const { config, data } = cliDirs();
  // A token or a config file can change how the CLI authenticates, which this check does not follow.
  if (process.env.SMARTTHINGS_TOKEN || existsSync(path.join(config, 'config.yaml'))) return { saved: null };
  try {
    const entry = JSON.parse(readFileSync(path.join(data, 'credentials.json'), 'utf8'))[`${PROFILE}:${API_HOST}`];
    return entry ? { saved: true, expires: Date.parse(entry.expires) } : { saved: false };
  } catch (error) {
    return { saved: error.code === 'ENOENT' ? false : null };
  }
}

// Two CLI processes refreshing together can invalidate each other's refresh token, so they only overlap when no refresh is near.
export function canOverlapRuns() {
  const { saved, expires } = loginState();
  return saved === true && expires > Date.now() + 2 * REFRESH_WINDOW_MS;
}
