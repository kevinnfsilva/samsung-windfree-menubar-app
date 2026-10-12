import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AcError, runCli } from './lib/ac-cli.mjs';
import { canOverlapRuns, loginState } from './lib/ac-login.mjs';
import { SETTINGS, parseStatus } from './lib/ac-status.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// The packaged app can't write inside its own signed bundle, so it names another folder for device.json.
const DEVICE_FILE = path.join(process.env.WINDFREE_DATA_DIR ?? ROOT, 'device.json');
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WORD = /^[A-Za-z][A-Za-z0-9]*$/;
const PLAUSIBLE_TEMP = { min: 5, max: 45 };
const CONFIRM_ATTEMPTS = 4;
const CONFIRM_INTERVAL_MS = 1500;

const ACTIONS = {
  liga: { key: 'ligado', expected: true, command: 'switch:on' },
  desliga: { key: 'ligado', expected: false, command: 'switch:off' },
  'zera-filtro': { key: 'filtroUso', expected: 0, command: 'custom.dustFilter:resetDustFilter' },
};

let signIn = false;

function cli(args) {
  return runCli(args, { signIn });
}

// A device id the SmartThings API does not know comes back as 403 or 404.
async function deviceCli(args) {
  try {
    return await cli(args);
  } catch (error) {
    if (error.status === 403 || error.status === 404) throw new AcError('aparelho', { detalhe: error.detalhe });
    throw error;
  }
}

function isAirConditioner({ components = [] }) {
  return components.some(({ capabilities = [] }) => capabilities.some(({ id }) => id === 'airConditionerMode'));
}

async function listAirConditioners() {
  const found = JSON.parse(await cli(['devices', '-j']))
    .filter(isAirConditioner)
    .map(({ deviceId, label, name }) => ({ id: deviceId, nome: label || name || null }));
  if (found.length === 0) throw new AcError('sem-ar');
  return found;
}

function savedDevice() {
  try {
    const { id, nome } = JSON.parse(readFileSync(DEVICE_FILE, 'utf8'));
    return typeof id === 'string' && DEVICE_ID.test(id) ? { id, nome: nome ?? null } : null;
  } catch {
    return null;
  }
}

function saveDevice(device) {
  writeFileSync(DEVICE_FILE, `${JSON.stringify(device, null, 2)}\n`);
}

// The first run picks the first AC on the SmartThings account; `usar <id>` points the app at another one.
async function loadDevice() {
  const saved = savedDevice();
  if (saved) return saved;
  const [first] = await listAirConditioners();
  saveDevice(first);
  return first;
}

function usageError(message) {
  return new AcError('desconhecido', { mensagem: message });
}

// The unit may support more than the built-in lists, so a plausible value outside them is checked against what the unit reports.
function parseValue(token, setting, raw) {
  const values = setting.values ?? Object.keys(setting.commands);
  const value = typeof values[0] === 'number' ? Number(raw) : raw;
  if (values.includes(value)) return { value };
  let plausible = false;
  if (token === 'temp') plausible = Number.isFinite(value) && value >= PLAUSIBLE_TEMP.min && value <= PLAUSIBLE_TEMP.max;
  else if (setting.supported) plausible = typeof value === 'number' ? value > 0 : typeof raw === 'string' && WORD.test(raw);
  if (!plausible) throw usageError(`${token} aceita: ${values.join(', ')}`);
  return { value, unverified: true };
}

// A value that cannot be sent is set aside and reported as unconfirmed, so it does not take the rest of the batch down.
// A batch with nothing else left to send is a plain usage error, which is what a command line wants.
function parseRequest(tokens) {
  const request = { actions: [], unverified: [], rejected: [], signIn: false, list: false, use: null, device: null };
  let start = 0;
  if (tokens[0] === 'aparelho') {
    if (typeof tokens[1] !== 'string' || !DEVICE_ID.test(tokens[1])) throw usageError('aparelho precisa do ID do aparelho');
    request.device = tokens[1];
    start = 2;
  }
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === 'status') continue;
    if (token === 'login') {
      request.signIn = true;
      continue;
    }
    if (token === 'aparelhos') {
      request.list = true;
      continue;
    }
    if (token === 'aparelho') throw usageError('aparelho só vale no começo, antes das outras ações');
    if (token === 'usar') {
      i += 1;
      if (typeof tokens[i] !== 'string' || !DEVICE_ID.test(tokens[i])) throw usageError('usar precisa do ID do aparelho');
      request.use = tokens[i];
      continue;
    }
    if (ACTIONS[token]) {
      request.actions.push(ACTIONS[token]);
      continue;
    }
    const setting = SETTINGS[token];
    if (!setting) {
      const known = ['status', 'login', 'aparelhos', 'aparelho', 'usar', ...Object.keys(ACTIONS), ...Object.keys(SETTINGS)];
      throw usageError(`Ação desconhecida: ${token}. Use: ${known.join(', ')}`);
    }
    i += 1;
    let parsed;
    try {
      parsed = parseValue(token, setting, tokens[i]);
    } catch (error) {
      request.rejected.push({ key: token, error });
      continue;
    }
    if (parsed.unverified) request.unverified.push({ key: token, value: parsed.value });
    request.actions.push({
      key: token,
      expected: parsed.value,
      command: setting.commands?.[parsed.value] ?? `${setting.capability}:${setting.command}(${JSON.stringify(parsed.value)})`,
    });
  }
  if (request.actions.length === 0 && request.rejected.length > 0) throw request.rejected[0].error;
  if (request.list && (request.actions.length > 0 || request.use)) {
    throw usageError('aparelhos não combina com outras ações');
  }
  if (request.device && (request.use || request.list)) throw usageError('aparelho não combina com usar nem com aparelhos');
  return request;
}

async function readHealth(deviceId) {
  try {
    const { state } = JSON.parse(await cli(['devices:health', deviceId, '-j']));
    return state === 'ONLINE' ? true : state === 'OFFLINE' ? false : null;
  } catch {
    // Health only adds to the status; a failure here must not hide the status itself.
    return null;
  }
}

// The health check runs alongside the status read when that is safe, so it adds no wait.
async function readDevice(device, { health }) {
  const alongside = health && canOverlapRuns() ? readHealth(device.id) : null;
  let raw;
  try {
    raw = await deviceCli(['devices:status', device.id, '-j']);
  } finally {
    await alongside;
  }
  const online = health ? await (alongside ?? readHealth(device.id)) : null;
  const main = JSON.parse(raw).components?.main;
  if (!main) throw new AcError('desconhecido');
  return { main, online };
}

// Returns the values this unit does not support, each with the error that says what it does.
function refusedByUnit(unverified, { limites }) {
  const refused = [];
  for (const { key, value } of unverified) {
    if (key === 'temp') {
      const { min, max, passo } = limites.temp;
      const onStep = Math.abs((value - min) / passo - Math.round((value - min) / passo)) < 1e-6;
      if (value < min || value > max || !onStep) refused.push({ key, value, error: usageError(`temp aceita de ${min} a ${max}`) });
    } else if (!limites[key].includes(value)) {
      refused.push({ key, value, error: usageError(`${key} aceita: ${limites[key].join(', ')}`) });
    }
  }
  return refused;
}

function pendingKeys(actions, status) {
  return actions.filter(({ key, expected }) => status[key] !== expected).map(({ key }) => key);
}

// A unit that is offline refuses commands; the status read afterwards then shows what it did not take.
// A command the unit itself answers with 400 or 422 is one it does not support: it is set aside and the rest still goes.
async function sendCommands(device, actions) {
  const refused = [];
  for (const action of actions) {
    try {
      await deviceCli(['devices:commands', device.id, action.command]);
    } catch (error) {
      if (error.erro === 'desconhecido' && (error.status === 400 || error.status === 422)) {
        refused.push(action);
        continue;
      }
      if (error.erro !== 'desconhecido' || (await readHealth(device.id)) !== false) throw error;
      break;
    }
  }
  return refused;
}

async function execute(request) {
  if (request.list) {
    const found = await listAirConditioners();
    const active = savedDevice()?.id ?? found[0].id;
    console.log(JSON.stringify({ aparelhos: found.map((device) => ({ ...device, ativo: device.id === active })) }));
    return;
  }

  let device;
  let switchingTo = null;
  if (request.use) {
    device = (await listAirConditioners()).find(({ id }) => id === request.use);
    if (!device) throw new AcError('aparelho', { mensagem: 'Esse ar-condicionado não está na sua conta SmartThings.' });
    switchingTo = device;
  } else if (request.device) {
    // Only for this run: the saved unit stays as it is, and its name is only known when it happens to be that one.
    const saved = savedDevice();
    device = { id: request.device, nome: saved?.id === request.device ? saved.nome : null };
  } else {
    device = await loadDevice();
  }

  let actions = request.actions;
  const rejected = [...request.rejected];
  if (request.unverified.length > 0) {
    const refused = refusedByUnit(request.unverified, parseStatus((await readDevice(device, { health: false })).main, device, null));
    actions = actions.filter(({ key, expected }) => !refused.some((one) => one.key === key && one.value === expected));
    rejected.push(...refused);
    if (actions.length === 0 && refused.length > 0) throw refused[0].error;
  }
  const refusedCommands = await sendCommands(device, actions);
  actions = actions.filter((action) => !refusedCommands.includes(action));

  const { main, online } = await readDevice(device, { health: true });
  let status = parseStatus(main, device, online);
  // Retrying is pointless while the unit is offline: it keeps reporting what it last knew.
  for (let attempt = 1; attempt < CONFIRM_ATTEMPTS && pendingKeys(actions, status).length > 0 && online !== false; attempt++) {
    await sleep(CONFIRM_INTERVAL_MS);
    status = parseStatus((await readDevice(device, { health: false })).main, device, online);
  }

  // The new unit becomes the saved one only once its status has been read, so a failed switch leaves everything as it was.
  if (switchingTo) saveDevice(switchingTo);
  const pendente = [
    ...new Set([...pendingKeys(actions, status), ...refusedCommands.map(({ key }) => key), ...rejected.map(({ key }) => key)]),
  ];
  console.log(JSON.stringify(pendente.length > 0 ? { ...status, pendente } : status));
}

async function run() {
  const request = parseRequest(process.argv.slice(2));
  signIn = request.signIn;
  if (!signIn && loginState().saved === false) throw new AcError('login');
  try {
    await execute(request);
  } catch (error) {
    // Asking for a sign-in must get one. The saved login is only dropped once the API is known to reject it,
    // because it may well be valid and the CLI signs in again by itself when it is not.
    if (!signIn || error.status !== 401) throw error;
    await cli(['logout']).catch(() => {});
    await execute(request);
  }
}

try {
  await run();
} catch (error) {
  const failure = error instanceof AcError ? error : new AcError('desconhecido', { mensagem: error.message });
  if (failure.detalhe) console.error(failure.detalhe);
  console.error(JSON.stringify({ erro: failure.erro, mensagem: failure.message }));
  process.exit(1);
}
