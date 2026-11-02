const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('studioToolbar', {
  action: name => ipcRenderer.invoke('studio:action', name),
  onState: callback => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('studio:state', listener)
    return () => ipcRenderer.removeListener('studio:state', listener)
  },
})
