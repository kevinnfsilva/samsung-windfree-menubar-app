// The languages the main process can speak; the panel loads the same files with <script> tags (see panel/index.html).
// A new language is one more file here plus one more entry below and one more <script> line in the panel.
module.exports = {
  'pt-BR': require('./pt-BR'),
  en: require('./en'),
};
