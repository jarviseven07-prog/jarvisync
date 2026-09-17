const { contextBridge, ipcRenderer } = require('electron');

const stateChannels = new Set(['desktop-window:state']);

function stateFrom(value) {
  return {
    isMaximized: value?.isMaximized === true,
    isFullScreen: value?.isFullScreen === true,
  };
}

contextBridge.exposeInMainWorld('desktopWindow', Object.freeze({
  platform: process.platform,
  getState: () => ipcRenderer.invoke('desktop-window:get-state').then(stateFrom),
  minimize: () => ipcRenderer.invoke('desktop-window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('desktop-window:toggle-maximize'),
  toggleFullScreen: () => ipcRenderer.invoke('desktop-window:toggle-full-screen'),
  close: () => ipcRenderer.invoke('desktop-window:close'),
  onStateChange: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const receive = (_event, state) => listener(stateFrom(state));
    const channel = 'desktop-window:state';
    if (!stateChannels.has(channel)) return () => {};
    ipcRenderer.on(channel, receive);
    return () => ipcRenderer.removeListener(channel, receive);
  },
}));
