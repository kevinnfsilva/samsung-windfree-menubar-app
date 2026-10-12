// On Electron's Node, yargs takes the CLI for a packaged Electron app and reads the script path as its first argument.
if (process.versions.electron) process.defaultApp = true;

await import('./node_modules/@smartthings/cli/dist/src/run.js');
