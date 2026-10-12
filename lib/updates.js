const { EventEmitter } = require('node:events');
const { isDeepStrictEqual } = require('node:util');
const { net } = require('electron');

const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 24 * 3_600_000;
const REQUEST_TIMEOUT_MS = 10_000;
const GITHUB_HOST = 'github.com';
// Only a plain "X.Y.Z", with an optional leading "v": a pre-release or any other odd tag is not something to offer.
const VERSION_PATTERN = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;
// package.json writes the repository as a string or as { url }, and the address comes in several shapes (git+https://, git@, github:).
const REPOSITORY_PATTERN =
  /^(?:(?:git\+)?(?:https?|ssh|git):\/\/(?:git@)?(?:www\.)?github\.com\/|git@github\.com:|github:)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

function parseRepository(repository) {
  const address = typeof repository === 'string' ? repository : repository?.url;
  const match = typeof address === 'string' ? REPOSITORY_PATTERN.exec(address.trim()) : null;
  return match ? { owner: match[1], repo: match[2] } : null;
}

function parseVersion(text) {
  const match = typeof text === 'string' ? VERSION_PATTERN.exec(text) : null;
  return match ? match.slice(1).map(Number) : null;
}

// Numeric, part by part: 1.10.0 is newer than 1.9.0.
function isNewer(tag, installed) {
  const latest = parseVersion(tag);
  const current = parseVersion(installed);
  if (!latest || !current) return false;
  const differing = latest.findIndex((part, index) => part !== current[index]);
  return differing >= 0 && latest[differing] > current[differing];
}

// The page the answer points to, or the repository's "latest release" page when it points anywhere else: the browser is
// only ever sent to github.com, over https, inside this repository.
function releaseUrl({ owner, repo }, candidate) {
  const fallback = `https://${GITHUB_HOST}/${owner}/${repo}/releases/latest`;
  if (typeof candidate !== 'string') return fallback;
  try {
    const url = new URL(candidate);
    const base = `/${owner}/${repo}`.toLowerCase();
    const path = url.pathname.toLowerCase();
    const inRepository = path === base || path.startsWith(`${base}/`);
    const plain = url.protocol === 'https:' && url.hostname === GITHUB_HOST && !url.port && !url.username && !url.password;
    return plain && inRepository ? url.href : fallback;
  } catch {
    return fallback;
  }
}

// Asks GitHub which release is the latest and keeps `notice` ({ versao, url } or null) in step. It never downloads or installs
// anything, and every kind of failure just leaves things as they were.
class UpdateChecker extends EventEmitter {
  #repository;
  #installed;
  #usable;
  #active = false;
  #timer = null;
  #request = null;
  #lastCheckAt = null;
  #notice = null;

  constructor({ repository, version }) {
    super();
    this.#repository = parseRepository(repository);
    this.#installed = version;
    this.#usable = this.#repository !== null && parseVersion(version) !== null;
  }

  get notice() {
    return this.#notice ? { ...this.#notice } : null;
  }

  start(enabled) {
    this.#active = enabled && this.#usable;
    if (this.#active) this.#arm(FIRST_CHECK_MS);
  }

  // Switching on looks right away; switching off forgets the notice and drops any answer still on its way.
  setEnabled(enabled) {
    const active = enabled && this.#usable;
    if (active === this.#active) return;
    this.#active = active;
    if (active) {
      this.check();
    } else {
      this.#cancel();
      this.#show(null);
    }
  }

  stop() {
    this.#active = false;
    this.#cancel();
  }

  // Timers stand still while the computer sleeps, so waking up is the moment to look at the clock again.
  resume() {
    if (!this.#active || this.#request) return;
    const waited = this.#lastCheckAt === null ? CHECK_EVERY_MS : Date.now() - this.#lastCheckAt;
    if (waited >= CHECK_EVERY_MS) this.check();
    else this.#arm(CHECK_EVERY_MS - Math.max(0, waited));
  }

  // The address is checked again on the way out, so that whatever the state holds, only a page of this repository is opened.
  downloadPage() {
    return this.#notice ? releaseUrl(this.#repository, this.#notice.url) : null;
  }

  async check() {
    if (!this.#active) return;
    this.#cancel();
    const request = new AbortController();
    this.#request = request;
    const timeout = setTimeout(() => request.abort(), REQUEST_TIMEOUT_MS);
    let found;
    try {
      found = await this.#fetchLatest(request.signal);
    } catch {
      // Offline, too slow, not JSON: the person hears nothing either way, so the reason does not matter.
    } finally {
      clearTimeout(timeout);
    }
    // Switched off, or replaced by a newer check, while waiting: this answer is no longer wanted.
    if (this.#request !== request) return;
    this.#request = null;
    this.#lastCheckAt = Date.now();
    this.#arm(CHECK_EVERY_MS);
    // A failed check says nothing about releases, so what was known before stays.
    if (found !== undefined) this.#show(found);
  }

  async #fetchLatest(signal) {
    const { owner, repo } = this.#repository;
    const response = await net.fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `WindFree/${this.#installed}` },
      credentials: 'omit',
      signal,
    });
    return response.ok ? this.#interpret(await response.json()) : undefined;
  }

  // undefined: the answer says nothing usable; null: there is nothing newer; otherwise the notice.
  #interpret(release) {
    const latest = parseVersion(release?.tag_name);
    // "Latest" never means a draft or a pre-release, so an answer that says otherwise is not to be trusted.
    if (!latest || release.draft === true || release.prerelease === true) return undefined;
    if (!isNewer(release.tag_name, this.#installed)) return null;
    return { versao: latest.join('.'), url: releaseUrl(this.#repository, release.html_url) };
  }

  #arm(delay) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.check(), delay);
  }

  #cancel() {
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#request?.abort();
    this.#request = null;
  }

  #show(notice) {
    if (isDeepStrictEqual(notice, this.#notice)) return;
    this.#notice = notice;
    this.emit('change', this.notice);
  }
}

module.exports = { UpdateChecker, isNewer, parseRepository, parseVersion, releaseUrl };
