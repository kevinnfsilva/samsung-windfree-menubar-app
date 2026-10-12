// Texts live in ../locales/<code>.js, which register themselves on WindFreeLocales (the CSP only lets the page run scripts
// from the app itself). t() reads the active dictionary, then English, then falls back to the key.

const FALLBACK_LOCALE = 'en';

let activeLocale = FALLBACK_LOCALE;
let pluralRules = new Intl.PluralRules(WindFreeLocales[FALLBACK_LOCALE]['meta.intl']);
let numberFormat = new Intl.NumberFormat(WindFreeLocales[FALLBACK_LOCALE]['meta.intl'], { maximumFractionDigits: 1 });

function primaryOf(tag) {
  return String(tag).toLowerCase().split(/[-_]/)[0];
}

// Same matching as lib/i18n.js: the same code, then the same language ("pt-PT" gets "pt-BR"), then English.
function matchLocale(wanted) {
  const codes = Object.keys(WindFreeLocales);
  const tag = String(wanted ?? '').toLowerCase();
  return codes.find((code) => code.toLowerCase() === tag) ?? codes.find((code) => primaryOf(code) === primaryOf(tag)) ?? FALLBACK_LOCALE;
}

function intlLocale() {
  return WindFreeLocales[activeLocale]['meta.intl'];
}

// A fractional count ("1.5 hours") always takes the plural form, whatever the language's rules say about 1.5.
function pluralKey(key, count) {
  const category = Number.isInteger(count) ? pluralRules.select(count) : 'other';
  const dictionary = WindFreeLocales[activeLocale];
  const fallback = WindFreeLocales[FALLBACK_LOCALE];
  return [`${key}.${category}`, `${key}.other`].find((name) => name in dictionary || name in fallback) ?? key;
}

function t(key, params = {}) {
  const name = typeof params.count === 'number' ? pluralKey(key, params.count) : key;
  const template = WindFreeLocales[activeLocale][name] ?? WindFreeLocales[FALLBACK_LOCALE][name] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, param) => {
    if (!(param in params)) return match;
    return param === 'count' && typeof params.count === 'number' ? numberFormat.format(params.count) : String(params[param]);
  });
}

// Static texts are marked in index.html: data-i18n for the content, data-i18n-<attribute> for these attributes.
const LOCALIZED_ATTRIBUTES = ['aria-label', 'title', 'placeholder'];

function applyStaticTexts() {
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const name of LOCALIZED_ATTRIBUTES) {
    for (const node of document.querySelectorAll(`[data-i18n-${name}]`)) node.setAttribute(name, t(node.getAttribute(`data-i18n-${name}`)));
  }
}

// Switches the dictionary and the static texts; app.js redraws what the scripts render.
function setLocale(code) {
  activeLocale = matchLocale(code);
  const intl = intlLocale();
  pluralRules = new Intl.PluralRules(intl);
  numberFormat = new Intl.NumberFormat(intl, { maximumFractionDigits: 1 });
  document.documentElement.lang = activeLocale;
  applyStaticTexts();
}

// The page does not know the setting before getState() answers, so it starts from the system language to not flash a wrong one.
setLocale(navigator.language);
