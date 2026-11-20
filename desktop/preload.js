// ═══════════════════════════════════════════════════════════════════════════════
// PRELOAD — the panel's only way to reach the main process: a few named calls,
// exposed as window.sim. The panel gets no Node.js or Electron access itself.
// ═══════════════════════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron');

const call = name => (...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld('sim', {
  snapshot:       call('snapshot'),        // → { room, cfg, backend, conductor, solo, mute, phones }
  setCount:       call('count'),           // (n)
  add:            call('add'),             // (how many)
  remove:         call('remove'),          // ([client numbers])
  setOutputs:     call('outputs'),         // ({ client: { device, channels } })
  setSpeaker:     call('speaker'),         // (device label, { name })
  devicesChanged: call('devices-changed'),
  solo:           call('solo'),            // ([client numbers]); [] clears
  mute:           call('mute'),            // ([client numbers], on)
  test:           call('test'),            // (client): its test tone
  identify:       call('identify'),        // ([client numbers]): their test tones in turn
  show:           call('show'),            // (client): open its page in a window
  rejoin:         call('rejoin'),          // (client): reload it
  transport:      call('transport'),       // ('toggle' | 'play' | 'pause' | 'stop')
  conductorSlot:  call('conductor-slot'),  // ({ x, y, width, height } | null)
  conductorLayout: call('conductor-layout'), // ({ shown, width }): saved
  setConnection:  call('connection'),      // ({ backend, site, broker })
  onUpdate:   fn => ipcRenderer.on('update', (ev, s) => fn(s)),
  onShortcut: fn => ipcRenderer.on('shortcut', (ev, key) => fn(key)),
});
