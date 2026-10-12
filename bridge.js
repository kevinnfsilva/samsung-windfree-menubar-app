const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');

const IS_MAC = process.platform === 'darwin';
const AC_SCRIPT = path.join(__dirname, 'ac.mjs');
const FLUSH_DELAY_MS = 600;
const RUN_TIMEOUT_MS = 120_000;
// The CLI itself waits up to ten minutes for the browser sign-in; the rest of the run gets the usual limit on top.
const LOGIN_TIMEOUT_MS = 10 * 60_000 + RUN_TIMEOUT_MS;
const CLIMATE_KEYS = new Set(['temp', 'modo', 'vento', 'extra', 'oscilar']);
const ON_OFF_KEYS = new Set(['display', 'bipe', 'autoclean', 'limpeza', 'diagnostico']);
const SETTABLE_KEYS = new Set(['ligado', ...CLIMATE_KEYS, ...ON_OFF_KEYS, 'filtroAlerta', 'tropical']);
const ONE_SHOT_ACTIONS = new Set(['zera-filtro']);
const FAILURE_REASONS = new Set(['login', 'rede', 'sem-ar', 'aparelho', 'desconhecido']);
const APPLY_FAILURE_REASONS = new Set(['login', 'rede', 'aparelho', 'tempo']);
// Reasons that prove the sign-in itself worked: the API accepted the login and only the next step failed.
const SIGNED_IN_REASONS = new Set(['sem-ar', 'aparelho']);
const TIMEOUT_MESSAGE = 'Sem resposta do SmartThings.';
const CRASH_MESSAGE = 'O processo do ar-condicionado terminou de forma inesperada.';

const RunKind = Object.freeze({
  Idle: 'idle',
  Command: 'command',
  Refresh: 'refresh',
  Login: 'login',
  Devices: 'devices',
  Use: 'use',
  Apply: 'apply',
});

const KillReason = Object.freeze({
  Timeout: 'timeout',
  Cancel: 'cancel',
  Dispose: 'dispose',
});

function arTokens(changes) {
  const tokens = changes.get('ligado') === true ? ['liga'] : [];
  for (const [key, value] of changes) {
    if (key !== 'ligado') tokens.push(key, String(value));
  }
  if (changes.get('ligado') === false) tokens.push('desliga');
  return tokens;
}

function normalized(key, value) {
  return ON_OFF_KEYS.has(key) && typeof value === 'boolean' ? (value ? 'on' : 'off') : value;
}

function lastLine(text) {
  return text.trim().split('\n').pop();
}

// ac.mjs ends a failed run with {"erro","mensagem"} as the last line of stderr.
function failureFrom({ spawnError }, stderr) {
  const line = lastLine(stderr);
  try {
    const { erro, mensagem } = JSON.parse(line);
    return { reason: FAILURE_REASONS.has(erro) ? erro : 'desconhecido', message: mensagem };
  } catch {
    return { reason: 'desconhecido', message: line || spawnError?.message || CRASH_MESSAGE };
  }
}

function lowerPriority(pid) {
  if (!pid) return;
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // The status read can finish before we get to lower its priority.
  }
}

class AcBridge extends EventEmitter {
  #script;
  #confirmed = null;
  #pending = new Map();
  #inflight = new Map();
  #oneShots = [];
  #queued = [];
  #job = null;
  #run = RunKind.Idle;
  #child = null;
  #killReason = null;
  #killTimer = null;
  #error = null;
  #updatedAt = null;
  #flushTimer = null;
  #timedOut = false;
  #login = 'ok';
  #loginBefore = 'ok';
  #devices = null;
  #disposed = false;

  constructor({ script = AC_SCRIPT } = {}) {
    super();
    this.#script = script;
  }

  get updatedAt() {
    return this.#updatedAt;
  }

  // Polling on its own would fail at once while a sign-in is needed, and after a timeout it would only pile up more stuck runs.
  get paused() {
    return this.#login !== 'ok' || this.#timedOut;
  }

  view() {
    const sendable = this.#sendable();
    const device = this.#confirmed && {
      ...this.#confirmed,
      ...Object.fromEntries(this.#inflight),
      ...Object.fromEntries(this.#pending),
    };
    return {
      device,
      syncing:
        this.#run === RunKind.Command ||
        this.#run === RunKind.Use ||
        this.#isQueued(RunKind.Use) ||
        (this.#run === RunKind.Apply && this.#job.deviceId === this.#confirmed?.id) ||
        sendable.size > 0 ||
        this.#oneShots.length > 0,
      held: [...this.#pending.keys()].filter((key) => !sendable.has(key)),
      updatedAt: this.#updatedAt,
      login: this.#login,
      devices: this.#devices,
      error: this.#error,
    };
  }

  // A change made while the unit is being switched was meant for the one still on screen, which is being left behind.
  // Comparing it with the old unit's state and sending it to the new one would be wrong either way, so it is dropped.
  set(key, value, { force = false } = {}) {
    if (this.#disposed || this.#switching() || !SETTABLE_KEYS.has(key)) return;
    const wanted = normalized(key, value);
    const alreadyThere = !force && this.#confirmed?.[key] === wanted && !this.#inflight.has(key);
    if (alreadyThere) this.#pending.delete(key);
    else this.#pending.set(key, wanted);
    this.#error = null;
    this.#changed();
    this.#scheduleFlush();
  }

  run(action) {
    if (this.#disposed || this.#switching() || !ONE_SHOT_ACTIONS.has(action)) return;
    if (!this.#oneShots.includes(action)) this.#oneShots.push(action);
    this.#error = null;
    this.#changed();
    this.#scheduleFlush();
  }

  // Sends changes to one unit in a run of its own, after whatever is in flight, whether or not it is the active one.
  // The active unit never changes here, and the view only follows the result when it is that unit's.
  apply(deviceId, changes) {
    const wanted = new Map(
      Object.entries(changes ?? {})
        .filter(([key, value]) => SETTABLE_KEYS.has(key) && value != null)
        .map(([key, value]) => [key, normalized(key, value)]),
    );
    if (this.#disposed || wanted.size === 0) return Promise.resolve({ ok: false, reason: 'desconhecido' });
    if (typeof deviceId !== 'string' || deviceId === '') return Promise.resolve({ ok: false, reason: 'aparelho' });
    return new Promise((resolve) => {
      this.#enqueue({ kind: RunKind.Apply, tokens: ['aparelho', deviceId, ...arTokens(wanted)], deviceId, resolve });
    });
  }

  refresh() {
    if (this.#disposed || this.#run !== RunKind.Idle) return;
    this.#start({ kind: RunKind.Refresh, tokens: [] });
  }

  login() {
    if (this.#disposed || this.#login === 'waiting') return;
    this.#loginBefore = this.#login;
    this.#login = 'waiting';
    this.#enqueue({ kind: RunKind.Login, tokens: ['login'] });
  }

  cancelLogin() {
    const waiting = this.#queued.length;
    this.#queued = this.#queued.filter(({ kind }) => kind !== RunKind.Login);
    if (this.#run === RunKind.Login) {
      this.#kill(KillReason.Cancel);
    } else if (this.#queued.length < waiting) {
      this.#login = 'needed';
      this.#changed();
    }
  }

  listDevices() {
    if (this.#disposed || this.#run === RunKind.Devices || this.#isQueued(RunKind.Devices)) return;
    this.#enqueue({ kind: RunKind.Devices, tokens: ['aparelhos'] });
  }

  useDevice(id) {
    if (this.#disposed || typeof id !== 'string' || id === '') return;
    // What is waiting was meant for the unit being left behind.
    this.#pending.clear();
    this.#oneShots = [];
    this.#queued = this.#queued.filter(({ kind }) => kind !== RunKind.Use);
    this.#enqueue({ kind: RunKind.Use, tokens: ['usar', id] });
  }

  dispose() {
    this.#disposed = true;
    clearTimeout(this.#flushTimer);
    const abandoned = this.#queued;
    this.#queued = [];
    for (const { resolve } of abandoned) resolve?.({ ok: false, reason: 'desconhecido' });
    this.#kill(KillReason.Dispose);
  }

  // The unit ignores climate changes while it is off, so those wait for a power-on.
  #sendable() {
    const willBeOn = this.#pending.get('ligado') ?? Boolean(this.#confirmed?.ligado);
    return new Map([...this.#pending].filter(([key]) => willBeOn || !CLIMATE_KEYS.has(key)));
  }

  #isQueued(kind) {
    return this.#queued.some((job) => job.kind === kind);
  }

  #switching() {
    return this.#run === RunKind.Use || this.#isQueued(RunKind.Use);
  }

  #enqueue(job) {
    if (this.#run === RunKind.Idle) {
      this.#start(job);
      return;
    }
    this.#queued.push(job);
    this.#changed();
  }

  #scheduleFlush() {
    clearTimeout(this.#flushTimer);
    this.#flushTimer = setTimeout(() => this.#flush(), FLUSH_DELAY_MS);
  }

  #flush() {
    if (this.#disposed || this.#run !== RunKind.Idle) return;
    const changes = this.#sendable();
    const actions = this.#oneShots;
    if (changes.size === 0 && actions.length === 0) return;
    for (const key of changes.keys()) this.#pending.delete(key);
    this.#oneShots = [];
    this.#inflight = changes;
    this.#start({ kind: RunKind.Command, tokens: [...arTokens(changes), ...actions] });
  }

  #start(job) {
    this.#job = job;
    this.#run = job.kind;
    this.#killReason = null;
    this.#changed();
    // macOS runs the script on Electron's own Node, so the app needs no Node installed.
    // Windows keeps the system one until that path is tested there.
    // On macOS the child leads its own process group, so one kill reaches the SmartThings CLI it starts as well.
    // execFile cannot do that: it ignores the detached option.
    const child = spawn(IS_MAC ? process.execPath : 'node', [this.#script, ...job.tokens], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(IS_MAC ? { detached: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } : {}),
    });
    let stdout = '';
    let stderr = '';
    let ended = false;
    const end = (failed, spawnError) => {
      if (ended) return;
      ended = true;
      this.#finish(job, { failed, spawnError }, stdout, stderr);
    };
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => end(true, error));
    child.on('close', (code) => end(code !== 0));
    this.#child = child;
    this.#killTimer = setTimeout(
      () => this.#kill(KillReason.Timeout),
      job.kind === RunKind.Login ? LOGIN_TIMEOUT_MS : RUN_TIMEOUT_MS,
    );
    if (job.kind === RunKind.Refresh) lowerPriority(child.pid);
  }

  #kill(reason) {
    const child = this.#child;
    if (!child || this.#killReason) return;
    this.#killReason = reason;
    try {
      if (IS_MAC && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill();
    } catch {
      // It finished between the decision and the kill.
    }
  }

  #finish(job, outcome, stdout, stderr) {
    clearTimeout(this.#killTimer);
    const killReason = this.#killReason;
    this.#run = RunKind.Idle;
    this.#job = null;
    this.#child = null;
    this.#killReason = null;
    this.#inflight = new Map();
    this.#timedOut = killReason === KillReason.Timeout;
    const { failure, result } = this.#judge(killReason, outcome, stdout, stderr);
    if (!this.#disposed) {
      // An apply is about the unit it names; the view only follows it when that is the active one.
      const shown = job.kind !== RunKind.Apply || job.deviceId === this.#confirmed?.id;
      if (failure) this.#fail(job.kind, failure, shown);
      else this.#accept(job.kind, result, shown);
      this.#changed();
    }
    job.resolve?.(this.#applyResult(failure, result));
    if (!this.#disposed) this.#next();
  }

  #judge(killReason, outcome, stdout, stderr) {
    if (killReason === KillReason.Timeout) return { failure: { reason: 'tempo', message: TIMEOUT_MESSAGE } };
    if (killReason) return { failure: { reason: 'cancelado' } };
    if (outcome.failed) return { failure: failureFrom(outcome, stderr) };
    try {
      return { result: JSON.parse(lastLine(stdout)) };
    } catch (failure) {
      return { failure: { reason: 'desconhecido', message: failure.message } };
    }
  }

  #applyResult(failure, result) {
    if (failure) return { ok: false, reason: APPLY_FAILURE_REASONS.has(failure.reason) ? failure.reason : 'desconhecido' };
    if (result.pendente?.length > 0) return { ok: false, reason: 'nao-confirmado', keys: result.pendente };
    return { ok: true };
  }

  #accept(kind, result, shown) {
    // A sign-in that is still pending keeps showing as pending, whatever other run happens to finish first.
    if (this.#login !== 'waiting' || kind === RunKind.Login) this.#login = 'ok';
    if (kind === RunKind.Devices) {
      this.#devices = result.aparelhos;
      return;
    }
    if (!shown) return;
    const { pendente = [], ...device } = result;
    this.#confirmed = device;
    this.#updatedAt = Date.now();
    this.#error = pendente.length > 0 ? { kind: 'unconfirmed', keys: pendente } : null;
    if (kind === RunKind.Use && this.#devices) {
      this.#devices = this.#devices.map((known) => ({ ...known, ativo: known.id === device.id }));
    }
  }

  #fail(kind, { reason, message }, shown) {
    // Signing in again is only asked for when the login is gone or the attempt to renew it was given up.
    const mustSignIn = reason === 'login' || reason === 'cancelado' || (kind === RunKind.Login && reason === 'tempo');
    if (kind === RunKind.Login) {
      if (mustSignIn) this.#login = 'needed';
      else if (SIGNED_IN_REASONS.has(reason)) this.#login = 'ok';
      else this.#login = this.#loginBefore;
    } else if (reason === 'login' && this.#login !== 'waiting') {
      this.#login = 'needed';
    }
    if (shown) this.#error = mustSignIn ? null : { kind: 'failed', reason, message };
  }

  #next() {
    const job = this.#queued.shift();
    if (job) this.#start(job);
    else if (this.#sendable().size > 0 || this.#oneShots.length > 0) this.#scheduleFlush();
  }

  #changed() {
    this.emit('change', this.view());
  }
}

module.exports = { AcBridge };
