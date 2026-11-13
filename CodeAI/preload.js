const { contextBridge, ipcRenderer: ipc, webUtils } = require('electron');
contextBridge.exposeInMainWorld('api', {
  openFolder: () => ipc.invoke('openFolder'),
  getAppInfo: () => ipc.invoke('getAppInfo'),
  checkForUpdates: () => ipc.invoke('checkForUpdates'),
  installUpdate: () => ipc.invoke('installUpdate'),
  cancelAI: () => ipc.send('cancelAI'),
  pickFiles: () => ipc.invoke('pickFiles'),
  describeFiles: paths => ipc.invoke('describeFiles', paths),
  getDroppedFilePaths: files => Array.from(files, file => webUtils.getPathForFile(file)).filter(Boolean),
  pickFolder: () => ipc.invoke('pickFolder'),
  readDir: p => ipc.invoke('readDir', p),
  searchFiles: (root, query) => ipc.invoke('searchFiles', { root, query }),
  reviewProject: root => ipc.invoke('reviewProject', root),
  createEntry: (parentPath, name, directory) => ipc.invoke('createEntry', { parentPath, name, directory }),
  renameEntry: (filePath, name) => ipc.invoke('renameEntry', { filePath, name }),
  deleteEntry: filePath => ipc.invoke('deleteEntry', filePath),
  applyProjectChanges: (root, changes) => ipc.invoke('applyProjectChanges', { root, changes }),
  saveProjectFile: (parentPath, name, content) => ipc.invoke('saveProjectFile', { parentPath, name, content }),
  readFile: p => ipc.invoke('readFile', p),
  writeFile: (p, c) => ipc.invoke('writeFile', p, c),
  setKey: k => ipc.invoke('setKey', k),
  hasKey: () => ipc.invoke('hasKey'),
  checkQwen: (url, model) => ipc.invoke('checkQwen', { url, model }),
  setQwenPriority: (url, enabled) => ipc.invoke('setQwenPriority', { url, enabled }),
  listChats: () => ipc.invoke('listChats'),
  saveChat: chat => ipc.invoke('saveChat', chat),
  deleteChat: id => ipc.invoke('deleteChat', id),
  saveGeneratedFile: file => ipc.invoke('saveGeneratedFile', file),
  openExternal: url => ipc.invoke('openExternal', url),
  runFile: file => ipc.invoke('runFile', file),
  stopRun: () => ipc.invoke('stopRun'),
  gitStatus: cwd => ipc.invoke('gitStatus', cwd),
  onRunOutput: callback => {
    const listener = (event, data) => callback(data);
    ipc.on('runOutput', listener);
    return () => ipc.removeListener('runOutput', listener);
  },
  onAIProgress: callback => {
    const listener = (event, data) => callback(data);
    ipc.on('aiProgress', listener);
    return () => ipc.removeListener('aiProgress', listener);
  },
  onUpdateStatus: callback => {
    const listener = (event, status) => callback(status);
    ipc.on('updateStatus', listener);
    return () => ipc.removeListener('updateStatus', listener);
  },
  ai: o => ipc.invoke('ai', o)
});
