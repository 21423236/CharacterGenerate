const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('forgeDesktop', {
  deleteProject: projectId => ipcRenderer.invoke('forge:delete-project', projectId),
  openStudio: projectId => ipcRenderer.invoke('forge:studio', projectId),
  automateStudio: (projectId, action) => ipcRenderer.invoke('forge:automate', projectId, action),
  studioState: projectId => ipcRenderer.invoke('forge:studio-state', projectId),
  onStudioState: callback => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('forge:studio-state', listener)
    return () => ipcRenderer.removeListener('forge:studio-state', listener)
  },
})
