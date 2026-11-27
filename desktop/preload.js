// ═══════════════════════════════════════════════════════════════════════════════
// PRELOAD — the panel's only way to reach the main process: a few named calls,
// exposed as window.sim. The panel gets no Node.js or Electron access itself.
// ═══════════════════════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron');

const call = name => (...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld('sim', {
  snapshot:       call('snapshot'),        // → { room, site, cfg, conductor, solo, mute, phones }
  setLink:        call('link'),            // (server link): load the conductor and the clients from it
  newRoom:        call('new-room'),         // start a fresh room on the current server
  setCount:       call('count'),           // (n)
  remove:         call('remove'),          // ([client numbers])
  setOutputs:     call('outputs'),         // ({ client: { device, channels } })
  devicesChanged: call('devices-changed'),
  solo:           call('solo'),            // ([client numbers]); [] clears
  mute:           call('mute'),            // ([client numbers], on)
  test:           call('test'),            // (client): its test tone
  show:           call('show'),            // (client): open its page in a window
  rejoin:         call('rejoin'),          // (client): reload it
  startStop:      call('start-stop'),      // the conductor's Start / Stop
  conductorSlot:  call('conductor-slot'),  // ({ x, y, width, height } | null)
  conductorLayout: call('conductor-layout'), // ({ shown, width }): saved
  onUpdate: fn => ipcRenderer.on('update', (ev, s) => fn(s)),
});
