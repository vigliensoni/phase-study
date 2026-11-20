// `npm start`: runs the app from source. Clears ELECTRON_RUN_AS_NODE, which
// some editors set in their terminals and which makes Electron run as Node.
const { spawn } = require('child_process');
const electron = require('electron'); // the path to the Electron binary
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env, cwd: require('path').join(__dirname, '..') })
  .on('exit', code => process.exit(code ?? 0));
