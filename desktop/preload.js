// ═══════════════════════════════════════════════════════════════════════════════
// PRELOAD — the panel's only way to reach the main process: a few named calls,
// exposed as window.sim. The panel gets no Node.js or Electron access itself.
// ═══════════════════════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron');

const call = name => (...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld('sim', {
  snapshot:       call('snapshot'),        // → { room, cfg, conductor, phones }
  setCount:       call('count'),           // (n)
  setSinks:       call('sinks'),           // ({ phone: device label })
  setSpeaker:     call('speaker'),         // (device label, { name, use })
  devicesChanged: call('devices-changed'),
  test:           call('test'),            // (phone): one beep
  show:           call('show'),            // (phone): open its page in a window
  rejoin:         call('rejoin'),          // (phone): reload it
  togglePlay:     call('toggle-play'),
  identify:       call('identify'),        // every phone beeps in turn
  setConnection:  call('connection'),      // ({ site, broker })
  onUpdate: fn => ipcRenderer.on('update', (ev, s) => fn(s)),
});
