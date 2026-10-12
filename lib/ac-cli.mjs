import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { OPEN_SHIM_DIR } from './ac-login.mjs';

const CLI_ENTRY = fileURLToPath(new URL('../smartthings.mjs', import.meta.url));
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const REACHABLE_CHECK_URL = 'https://auth-global.api.smartthings.com/';
const REACHABLE_CHECK_TIMEOUT_MS = 5000;
const RETRY_AFTER_BLOCKED_MS = 4000;
// The marker is how ac.mjs learns that the open shim ended a run. Windows has no shim, only the credentials pre-check.
const GUARD_BROWSER = process.platform === 'darwin';
const HTTP_FAILURE = /Request to API failed with status (\d+|undefined)/;
const NETWORK_FAILURE = /\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE)\b|socket hang up|fetch failed/;
// The CLI rejects with a bare string when the browser sign-in fails or times out.
const SIGN_IN_FAILURE = /unable to get authentication info|unable to obtain user credentials/;

const MESSAGES = {
  login: 'É preciso entrar na sua conta SmartThings.',
  rede: 'Sem conexão com o SmartThings.',
  'sem-ar': 'Nenhum ar-condicionado encontrado na sua conta SmartThings.',
  aparelho: 'O ar-condicionado salvo não está mais na sua conta SmartThings.',
  desconhecido: 'O SmartThings não conseguiu concluir o pedido.',
};

let runCount = 0;

export class AcError extends Error {
  constructor(erro, { mensagem = MESSAGES[erro], detalhe = null, status = null } = {}) {
    super(mensagem);
    this.erro = erro;
    this.detalhe = detalhe;
    this.status = status;
  }
}

async function isOffline() {
  try {
    await fetch(REACHABLE_CHECK_URL, { method: 'HEAD', signal: AbortSignal.timeout(REACHABLE_CHECK_TIMEOUT_MS) });
    return false;
  } catch {
    return true;
  }
}

// The CLI prints axios failures as "Request to API failed with status N" (N is undefined when nothing answered).
function failureFrom(stderr) {
  const detalhe = stderr.trim() || null;
  const http = HTTP_FAILURE.exec(stderr);
  const status = http && http[1] !== 'undefined' ? Number(http[1]) : null;
  if (status === 401 || SIGN_IN_FAILURE.test(stderr)) return new AcError('login', { detalhe, status });
  // Without a status nothing answered; 5xx and 429 mean SmartThings itself is struggling.
  const unreachable = http ? status === null || status >= 500 || status === 429 : NETWORK_FAILURE.test(stderr);
  return new AcError(unreachable ? 'rede' : 'desconhecido', { detalhe, status });
}

// What a guarded run throws when the CLI reached for the browser and the open shim ended it.
class BlockedOpen extends Error {}

function runOnce(args, signIn) {
  const marker = path.join(os.tmpdir(), `windfree-open-${process.pid}-${++runCount}`);
  const guarded = GUARD_BROWSER && !signIn;
  const env = guarded
    ? { ...process.env, PATH: `${OPEN_SHIM_DIR}${path.delimiter}${process.env.PATH ?? ''}`, WINDFREE_OPEN_MARKER: marker }
    : process.env;
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [CLI_ENTRY, ...args],
      { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, env },
      (error, stdout, stderr) => {
        const blocked = guarded && existsSync(marker);
        rmSync(marker, { force: true });
        if (!error) resolve(stdout);
        else reject(blocked ? new BlockedOpen() : failureFrom(stderr));
      },
    );
    child.stdin.end();
  });
}

// Only a run with signIn may open the browser; any other run that reaches the CLI's login ends with a login error.
export async function runCli(args, { signIn = false } = {}) {
  try {
    return await runOnce(args, signIn);
  } catch (error) {
    if (!(error instanceof BlockedOpen)) throw error;
  }
  // With a saved login the CLI only gets here when its token refresh failed, and that is often a passing problem:
  // being offline, or a network that is just coming back after the Mac woke up. Nothing was sent yet, so asking again is safe.
  if (await isOffline()) throw new AcError('rede');
  await sleep(RETRY_AFTER_BLOCKED_MS);
  try {
    return await runOnce(args, signIn);
  } catch (error) {
    throw error instanceof BlockedOpen ? new AcError('login') : error;
  }
}
