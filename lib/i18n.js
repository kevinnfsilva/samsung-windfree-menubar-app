const locales = require('../locales');

const FALLBACK_LANGUAGE = 'en';
const SETTING_AUTO = 'auto';

function primaryOf(tag) {
  return String(tag).toLowerCase().split(/[-_]/)[0];
}

// The language the app speaks for the `idioma` setting. "auto" follows the system: the same code first, then the same
// language ("pt-PT" gets "pt-BR"), and English for anything the app has no dictionary for.
function resolveLanguage(setting, systemLocale) {
  if (setting !== SETTING_AUTO && Object.hasOwn(locales, setting)) return setting;
  const codes = Object.keys(locales);
  const wanted = String(systemLocale ?? '').toLowerCase();
  const exact = codes.find((code) => code.toLowerCase() === wanted);
  return exact ?? codes.find((code) => primaryOf(code) === primaryOf(wanted)) ?? FALLBACK_LANGUAGE;
}

// Everything that can be read in one language: `t` for the dictionary, `number` for the digits.
function createI18n(requested) {
  const language = Object.hasOwn(locales, requested) ? requested : FALLBACK_LANGUAGE;
  const dictionary = locales[language];
  const fallback = locales[FALLBACK_LANGUAGE];
  const intl = dictionary['meta.intl'];
  const plurals = new Intl.PluralRules(intl);
  const numberFormat = new Intl.NumberFormat(intl, { maximumFractionDigits: 1 });

  const number = (value) => numberFormat.format(value);

  // A fractional count ("1.5 hours") always takes the plural form, whatever the language's rules say about 1.5.
  function pluralKey(key, count) {
    const category = Number.isInteger(count) ? plurals.select(count) : 'other';
    return [`${key}.${category}`, `${key}.other`].find((name) => name in dictionary || name in fallback);
  }

  function t(key, params = {}) {
    const name = typeof params.count === 'number' ? pluralKey(key, params.count) ?? key : key;
    const template = dictionary[name] ?? fallback[name] ?? key;
    return template.replace(/\{(\w+)\}/g, (match, param) => {
      if (!(param in params)) return match;
      return param === 'count' && typeof params.count === 'number' ? number(params.count) : String(params[param]);
    });
  }

  return { language, t, number };
}

module.exports = { createI18n, resolveLanguage };
