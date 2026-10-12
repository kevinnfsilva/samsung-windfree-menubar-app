// With the Dock icon on, the app gets a menu bar. The default menu has Close Window (Cmd+W), which destroys the panel,
// so this one only holds what is safe: About, Hide and Quit, plus Edit for the text fields in the panel.
function appMenuTemplate(name) {
  return [
    {
      label: name,
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { type: 'separator' }, { role: 'quit' }],
    },
    { role: 'editMenu' },
  ];
}

module.exports = { appMenuTemplate };
