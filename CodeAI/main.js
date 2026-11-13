const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const { spawn, spawnSync, execFile } = require('child_process');
const { mergeConsecutiveMessages } = require('./chat-utils');
const { readOpenAICompatibleResponse } = require('./ai-stream');
const { randomUUID } = require('crypto');
const { autoUpdater } = require('electron-updater');

const MODEL = 'claude-sonnet-5-5';
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;
const MAX_INLINE_FILE_SIZE = 5 * 1024 * 1024;
const MAX_INLINE_TOTAL_SIZE = 8 * 1024 * 1024;
const QWEN_TIMEOUT_MS = 15 * 60 * 1000;
const QWEN_ECONOMY_LIMITS = { historyMessages: 6, textChars: 16000, inlineBytes: 3 * 1024 * 1024 };
const MAX_TEXT_CHARS = 100000;
const MAX_FOLDER_FILES = 80;
const MAX_ARCHIVE_TEXT = 256 * 1024;
const MAX_PROJECT_REVIEW_CHARS = 140000;
const keyFile = () => path.join(app.getPath('userData'), 'key.bin');
const chatsFile = () => path.join(app.getPath('userData'), 'chats.json');
let debugProcess = null;
let mainWindow = null;
let updateStatus = { state: 'idle', message: 'Automatické aktualizace čekají na vydání aplikace.' };
const workspaceRoots = new Map();
const aiRequests = new Map();

ipcMain.on('cancelAI', e => {
  const controller = aiRequests.get(e.sender.id);
  if (controller) controller.abort();
});

function setUpdateStatus(state, message, version) {
  updateStatus = { state, message, version: version || null };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updateStatus', updateStatus);
  }
}

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.on('checking-for-update', () => setUpdateStatus('checking', 'Kontroluji nové vydání…'));
autoUpdater.on('update-available', info => setUpdateStatus('downloading', `Stahuji verzi ${info.version}…`, info.version));
autoUpdater.on('download-progress', progress => {
  setUpdateStatus('downloading', `Stahování aktualizace: ${Math.round(progress.percent)} %`);
});
autoUpdater.on('update-not-available', info => setUpdateStatus('up-to-date', `Aplikace je aktuální (${info.version}).`, info.version));
autoUpdater.on('update-downloaded', info => setUpdateStatus('downloaded', `Verze ${info.version} je připravena k instalaci.`, info.version));
autoUpdater.on('error', error => {
  const message = /404|not found|no published versions/i.test(error.message)
    ? 'Na GitHubu zatím není vydaná verze aplikace. Publikuj nejprve instalační balíček.'
    : `Aktualizaci se nepodařilo ověřit: ${error.message}`;
  setUpdateStatus('error', message);
});

function pathIsWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveWorkspacePath(sender, input, allowMissing) {
  const root = workspaceRoots.get(sender.id);
  if (!root) throw new Error('Nejprve otevři složku projektu.');
  if (typeof input !== 'string' || !input) throw new Error('Neplatná cesta.');
  const target = path.resolve(input);
  if (!pathIsWithin(root, target) || target === root) {
    if (target !== root) throw new Error('Cesta musí zůstat uvnitř otevřené složky.');
  }
  const exists = fs.existsSync(target);
  if (!exists && !allowMissing) throw new Error('Soubor nebo složka neexistuje.');
  const checkPath = fs.realpathSync(exists ? target : path.dirname(target));
  if (!pathIsWithin(root, checkPath) || (target !== root && checkPath === root && exists)) {
    throw new Error('Cesta přesahuje otevřenou složku projektu.');
  }
  return target;
}

function createWindow() {
  const w = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#181818',
    title: 'Code AI',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow = w;
  const webContentsId = w.webContents.id;
  w.on('closed', () => {
    workspaceRoots.delete(webContentsId);
    if (mainWindow === w) mainWindow = null;
  });
  w.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
  if (app.isPackaged) {
    setUpdateStatus('checking', 'Kontroluji nové vydání…');
    autoUpdater.checkForUpdates().catch(error => {
      setUpdateStatus('error', /404|not found|no published versions/i.test(error.message)
        ? 'Na GitHubu zatím není vydaná verze aplikace. Publikuj nejprve instalační balíček.'
        : `Aktualizaci se nepodařilo ověřit: ${error.message}`);
    });
  } else {
    setUpdateStatus('development', 'Automatické aktualizace fungují v nainstalovaném vydání.');
  }
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
ipcMain.handle('getAppInfo', () => ({
  version: app.getVersion(),
  packaged: app.isPackaged,
  updateStatus
}));
ipcMain.handle('checkForUpdates', async () => {
  if (!app.isPackaged) return updateStatus;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setUpdateStatus('error', /404|not found|no published versions/i.test(error.message)
      ? 'Na GitHubu zatím není vydaná verze aplikace. Publikuj nejprve instalační balíček.'
      : `Aktualizaci se nepodařilo ověřit: ${error.message}`);
  }
  return updateStatus;
});
ipcMain.handle('installUpdate', () => {
  if (!app.isPackaged || updateStatus.state !== 'downloaded') {
    throw new Error('Zatím není stažená žádná aktualizace.');
  }
  autoUpdater.quitAndInstall();
  return true;
});

async function loadChats() {
  try {
    const data = JSON.parse(await fs.promises.readFile(chatsFile(), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

let chatStoreQueue = Promise.resolve();
function updateChats(update) {
  const operation = chatStoreQueue.then(async () => {
    const chats = await loadChats();
    const result = update(chats);
    const file = chatsFile();
    const temp = `${file}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(chats), 'utf8');
    await fs.promises.rename(temp, file);
    return result;
  });
  chatStoreQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

ipcMain.handle('openFolder', async (e) => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (r.canceled) return null;
  const root = fs.realpathSync(r.filePaths[0]);
  workspaceRoots.set(e.sender.id, root);
  return root;
});

ipcMain.handle('pickFiles', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Všechny soubory', extensions: ['*'] }]
  });
  if (r.canceled) return [];
  return r.filePaths.map(file => {
    const stat = fs.statSync(file);
    return {
      path: file,
      name: path.basename(file),
      size: stat.size,
      type: path.extname(file).toLowerCase()
    };
  });
});
ipcMain.handle('describeFiles', (e, paths) => paths.map(file => {
  const stat = fs.statSync(file);
  return { path: file, name: path.basename(file), size: stat.size, type: path.extname(file).toLowerCase() };
}));
ipcMain.handle('pickFolder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (r.canceled) return null;
  return { path: r.filePaths[0], name: path.basename(r.filePaths[0]), size: 0, directory: true };
});

ipcMain.handle('saveGeneratedFile', async (e, { name, content }) => {
  const result = await dialog.showSaveDialog({ defaultPath: path.basename(name || 'ai-output.txt') });
  if (result.canceled || !result.filePath) return false;
  fs.writeFileSync(result.filePath, content, 'utf8');
  return true;
});

ipcMain.handle('saveProjectFile', async (e, { parentPath, name, content }) => {
  const parent = resolveWorkspacePath(e.sender, parentPath, false);
  if (!fs.statSync(parent).isDirectory()) throw new Error('Vybraná cesta není složka.');
  const relativePath = String(name || '').trim().replace(/\\/g, '/');
  const segments = relativePath.split('/');
  if (!relativePath || path.isAbsolute(relativePath) ||
      segments.some(segment => !segment || segment === '.' || segment === '..' || /[<>:"|?*\x00-\x1f]/.test(segment))) {
    throw new Error('AI navrhla neplatnou cestu k souboru.');
  }
  if (typeof content !== 'string') throw new Error('Obsah souboru není platný text.');
  let targetParent = parent;
  for (const directoryName of segments.slice(0, -1)) {
    const directoryPath = path.resolve(targetParent, directoryName);
    if (!pathIsWithin(workspaceRoots.get(e.sender.id), directoryPath)) {
      throw new Error('Cílová složka musí zůstat uvnitř otevřeného projektu.');
    }
    if (!fs.existsSync(directoryPath)) fs.mkdirSync(directoryPath);
    targetParent = resolveWorkspacePath(e.sender, directoryPath, false);
    if (!fs.statSync(targetParent).isDirectory()) {
      throw new Error(`Cílová cesta „${directoryName}“ není složka.`);
    }
  }
  const fileName = segments[segments.length - 1];
  const target = resolveWorkspacePath(e.sender, path.join(targetParent, fileName), true);
  let overwrite = false;
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isFile()) throw new Error('Soubor se stejným názvem už existuje jako složka.');
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Přepsat soubor', 'Zrušit'],
      defaultId: 1,
      cancelId: 1,
      title: 'Soubor už existuje',
      message: `AI chce uložit „${relativePath}“, ale soubor už existuje. Přepsat ho?`
    });
    if (confirmation.response !== 0) return null;
    overwrite = true;
  }
  fs.writeFileSync(target, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
  return {
    path: target,
    name: path.basename(target),
    relativePath: path.relative(parent, target).split(path.sep).join('/')
  };
});

ipcMain.handle('openExternal', async (e, rawUrl) => {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Neplatná adresa odkazu.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Povoleny jsou pouze HTTP/HTTPS odkazy.');
  await shell.openExternal(url.href);
  return true;
});

ipcMain.handle('runFile', (e, { filePath, cwd }) => {
  if (debugProcess) return { error: 'Proces už běží. Nejprve jej zastav.' };
  const resolvedRoot = resolveWorkspacePath(e.sender, cwd, false);
  const resolvedFile = resolveWorkspacePath(e.sender, filePath, false);
  if (resolvedRoot !== workspaceRoots.get(e.sender.id)) {
    return { error: 'Spuštění je povoleno pouze z otevřeného kořene projektu.' };
  }
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { error: 'Spouštěný soubor musí ležet uvnitř otevřené složky projektu.' };
  }
  const ext = path.extname(resolvedFile).toLowerCase();
  let command;
  let args;
  if (['.js', '.cjs', '.mjs'].includes(ext)) {
    command = 'node';
    args = [resolvedFile];
  } else if (ext === '.py') {
    command = 'python';
    args = [resolvedFile];
  } else if (ext === '.java') {
    command = 'java';
    args = [resolvedFile];
  } else if (ext === '.jar') {
    command = 'java';
    args = ['-jar', resolvedFile];
  } else if (ext === '.go') {
    command = 'go';
    args = ['run', resolvedFile];
  } else if (ext === '.rb') {
    command = 'ruby';
    args = [resolvedFile];
  } else if (ext === '.php') {
    command = 'php';
    args = [resolvedFile];
  } else if (ext === '.sh') {
    command = 'bash';
    args = [resolvedFile];
  } else if (ext === '.ps1') {
    command = 'powershell';
    args = ['-NoProfile', '-File', resolvedFile];
  } else if (ext === '.csproj') {
    command = 'dotnet';
    args = ['run', '--project', resolvedFile];
  } else {
    return { error: 'Vybraný typ souboru se nespouští samostatně. Podporováno: JS, Python, Java/JAR, Go, Ruby, PHP, Shell, PowerShell a .NET projekt (.csproj).' };
  }
  try {
    const child = spawn(command, args, { cwd: resolvedRoot, windowsHide: true, shell: false });
    debugProcess = child;
    const send = (type, text) => {
      if (!e.sender.isDestroyed()) e.sender.send('runOutput', { type, text: String(text) });
    };
    child.stdout.on('data', data => send('stdout', data));
    child.stderr.on('data', data => send('stderr', data));
    child.on('error', error => send('error', `Nepodařilo se spustit ${command}: ${error.message}`));
    child.on('close', (code, signal) => {
      send('exit', `\nProces skončil (kód ${code === null ? signal : code}).`);
      if (debugProcess === child) debugProcess = null;
    });
    send('start', `Spouštím: ${command} ${path.basename(resolvedFile)}\n`);
    return { started: true };
  } catch (error) {
    debugProcess = null;
    return { error: error.message };
  }
});

ipcMain.handle('stopRun', () => {
  if (!debugProcess) return false;
  debugProcess.kill();
  return true;
});

ipcMain.handle('gitStatus', (e, cwd) => {
  const projectRoot = resolveWorkspacePath(e.sender, cwd, false);
  const result = spawnSync('git', ['status', '--short', '--branch'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    shell: false
  });
  if (result.error) return { error: `Git není dostupný: ${result.error.message}` };
  if (result.status !== 0) return { error: (result.stderr || 'Tato složka není Git repozitář.').trim() };
  return { text: result.stdout.trim() || 'Pracovní strom je čistý.' };
});

ipcMain.handle('readDir', (e, p) => {
  const directory = resolveWorkspacePath(e.sender, p, false);
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(d => !['node_modules', '.git'].includes(d.name))
    .map(d => ({ name: d.name, path: path.join(directory, d.name), dir: d.isDirectory() }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
});
ipcMain.handle('searchFiles', (e, { root, query }) => {
  const projectRoot = resolveWorkspacePath(e.sender, root, false);
  const results = [];
  let visited = 0;
  const needle = String(query || '').toLowerCase();
  function walk(directory) {
    if (visited >= 3000 || results.length >= 100) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (visited >= 3000 || results.length >= 100) break;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.isSymbolicLink()) continue;
      visited++;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.toLowerCase().includes(needle)) {
        results.push({ name: entry.name, path: file, dir: false });
      }
    }
  }
  if (!needle) return [];
  walk(projectRoot);
  return results;
});
ipcMain.handle('reviewProject', (e, root) => {
  const projectRoot = resolveWorkspacePath(e.sender, root, false);
  const chunks = [];
  let filesRead = 0;
  let charsRead = 0;
  function walk(directory) {
    if (filesRead >= MAX_FOLDER_FILES || charsRead >= MAX_PROJECT_REVIEW_CHARS) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (filesRead >= MAX_FOLDER_FILES || charsRead >= MAX_PROJECT_REVIEW_CHARS) break;
      if (entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name === '.git' ||
          entry.name === 'dist' || entry.name === 'build' || isSensitiveFileName(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (entry.isFile() && textTypes.has(path.extname(entry.name).toLowerCase())) {
        const remaining = Math.min(12000, MAX_PROJECT_REVIEW_CHARS - charsRead);
        const excerpt = readTextExcerpt(file, remaining);
        const relative = path.relative(projectRoot, file);
        const chunk = `--- ${relative} ---\n${excerpt}`;
        chunks.push(chunk);
        filesRead++;
        charsRead += chunk.length;
      }
    }
  }
  walk(projectRoot);
  return {
    text: chunks.length
      ? `Projektová revize: výběr ${filesRead} textových souborů (${charsRead} znaků):\n${chunks.join('\n\n')}`
      : 'V projektu nebyly nalezeny podporované zdrojové soubory.',
    filesRead,
    truncated: filesRead >= MAX_FOLDER_FILES || charsRead >= MAX_PROJECT_REVIEW_CHARS
  };
});
ipcMain.handle('readFile', (e, p) => fs.readFileSync(resolveWorkspacePath(e.sender, p, false), 'utf8'));
ipcMain.handle('writeFile', (e, p, c) => {
  const file = resolveWorkspacePath(e.sender, p, true);
  fs.writeFileSync(file, c, 'utf8');
  return true;
});
ipcMain.handle('createEntry', (e, { parentPath, name, directory }) => {
  const parent = resolveWorkspacePath(e.sender, parentPath, false);
  const entryName = String(name || '').trim();
  if (!entryName || entryName === '.' || entryName === '..' || /[\\/<>:"|?*\x00-\x1f]/.test(entryName)) {
    throw new Error('Zadej platný název bez oddělovačů cesty.');
  }
  const target = resolveWorkspacePath(e.sender, path.join(parent, entryName), true);
  if (fs.existsSync(target)) throw new Error('Soubor nebo složka s tímto názvem už existuje.');
  if (directory) fs.mkdirSync(target);
  else fs.writeFileSync(target, '', { encoding: 'utf8', flag: 'wx' });
  return { path: target, name: entryName, dir: !!directory };
});
ipcMain.handle('renameEntry', (e, { filePath, name }) => {
  const source = resolveWorkspacePath(e.sender, filePath, false);
  const entryName = String(name || '').trim();
  if (!entryName || entryName === '.' || entryName === '..' || /[\\/<>:"|?*\x00-\x1f]/.test(entryName)) {
    throw new Error('Zadej platný název bez oddělovačů cesty.');
  }
  const target = resolveWorkspacePath(e.sender, path.join(path.dirname(source), entryName), true);
  if (fs.existsSync(target)) throw new Error('Soubor nebo složka s tímto názvem už existuje.');
  fs.renameSync(source, target);
  return true;
});
ipcMain.handle('deleteEntry', (e, filePath) => {
  const target = resolveWorkspacePath(e.sender, filePath, false);
  if (target === workspaceRoots.get(e.sender.id)) throw new Error('Kořenovou složku projektu nelze odstranit.');
  fs.rmSync(target, { recursive: true, force: false });
  return true;
});
ipcMain.handle('applyProjectChanges', (e, { root, changes }) => {
  const projectRoot = resolveWorkspacePath(e.sender, root, false);
  if (projectRoot !== workspaceRoots.get(e.sender.id)) throw new Error('Úpravy lze použít pouze na otevřený kořen projektu.');
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 30) {
    throw new Error('Návrh musí obsahovat 1 až 30 souborů.');
  }
  let totalBytes = 0;
  const normalized = changes.map(change => {
    if (!change || typeof change.path !== 'string' || typeof change.content !== 'string') {
      throw new Error('Každá změna musí obsahovat cestu a textový obsah.');
    }
    const relative = change.path.replace(/[\\/]+/g, path.sep);
    if (path.isAbsolute(relative) || relative.split(path.sep).some(part => !part || part === '.' || part === '..')) {
      throw new Error(`Neplatná cesta změny: ${change.path}`);
    }
    if (relative.split(path.sep).some(isSensitiveFileName)) {
      throw new Error(`Úprava citlivého souboru není povolena: ${change.path}`);
    }
    totalBytes += Buffer.byteLength(change.content, 'utf8');
    if (totalBytes > 8 * 1024 * 1024) throw new Error('Celková velikost návrhu přesahuje 8 MB.');
    const target = path.resolve(projectRoot, relative);
    if (!pathIsWithin(projectRoot, target) || target === projectRoot) throw new Error(`Cesta je mimo projekt: ${change.path}`);
    return { relative, target, content: change.content };
  });
  if (new Set(normalized.map(item => item.target.toLowerCase())).size !== normalized.length) {
    throw new Error('Návrh obsahuje duplicitní cesty.');
  }

  const staged = [];
  const committed = [];
  try {
    for (const item of normalized) {
      const parentParts = path.relative(projectRoot, path.dirname(item.target)).split(path.sep).filter(Boolean);
      let parent = projectRoot;
      for (const part of parentParts) {
        parent = path.join(parent, part);
        if (fs.existsSync(parent)) {
          const realParent = fs.realpathSync(parent);
          if (!pathIsWithin(projectRoot, realParent) || !fs.statSync(realParent).isDirectory()) {
            throw new Error(`Cesta vede mimo projekt nebo není složkou: ${item.relative}`);
          }
        } else {
          fs.mkdirSync(parent);
        }
      }
      if (fs.existsSync(item.target)) {
        const stat = fs.lstatSync(item.target);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Cílem není běžný soubor: ${item.relative}`);
      }
      const temp = `${item.target}.code-ai-${randomUUID()}.tmp`;
      fs.writeFileSync(temp, item.content, { encoding: 'utf8', flag: 'wx' });
      staged.push({ ...item, temp, backup: null });
    }
    for (const item of staged) {
      if (fs.existsSync(item.target)) {
        item.backup = `${item.target}.code-ai-${randomUUID()}.bak`;
        fs.renameSync(item.target, item.backup);
      }
      fs.renameSync(item.temp, item.target);
      committed.push(item);
    }
  } catch (error) {
    for (const item of committed.reverse()) {
      try {
        fs.rmSync(item.target, { force: true });
        if (item.backup && fs.existsSync(item.backup)) fs.renameSync(item.backup, item.target);
      } catch (rollbackError) {
        error.message += `; vrácení ${item.relative} selhalo: ${rollbackError.message}`;
      }
    }
    for (const item of staged) {
      if (fs.existsSync(item.temp)) fs.rmSync(item.temp, { force: true });
      if (item.backup && fs.existsSync(item.backup) && !fs.existsSync(item.target)) {
        fs.renameSync(item.backup, item.target);
      }
    }
    throw error;
  }
  for (const item of staged) {
    if (item.backup && fs.existsSync(item.backup)) fs.rmSync(item.backup, { force: true });
  }
  return normalized.map(item => item.relative);
});

ipcMain.handle('listChats', () => loadChats());
ipcMain.handle('saveChat', (e, chat) => updateChats(chats => {
  const index = chats.findIndex(item => item.id === chat.id);
  if (index < 0) chats.unshift(chat);
  else chats[index] = chat;
  return true;
}));
ipcMain.handle('deleteChat', (e, id) => updateChats(chats => {
  const remaining = chats.filter(chat => chat.id !== id);
  chats.splice(0, chats.length, ...remaining);
  return true;
}));

ipcMain.handle('setKey', (e, k) => {
  fs.writeFileSync(keyFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(k) : Buffer.from(k));
  return true;
});

function getKey() {
  try {
    const b = fs.readFileSync(keyFile());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString();
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

ipcMain.handle('hasKey', () => !!getKey());
ipcMain.handle('checkQwen', async (e, { url, model }) => {
  try {
    const base = new URL(url || 'http://127.0.0.1:1234');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.protocol !== 'http:') {
      return { available: false, error: 'Qwen endpoint musí být místní HTTP adresa.' };
    }
    const response = await fetch(new URL('/v1/models', base), { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return { available: false, error: `Qwen server odpověděl HTTP ${response.status}.` };
    const data = await response.json();
    const models = (data.data || []).map(item => item.id).filter(Boolean);
    const selectedModel = model || '';
    const modelAvailable = models.length > 0 && (!selectedModel || models.includes(selectedModel));
    return { available: true, modelAvailable, models };
  } catch {
    return { available: false, error: 'Qwen lokální server neběží.' };
  }
});

ipcMain.handle('setQwenPriority', async (e, { url, enabled }) => {
  let base;
  try {
    base = new URL(url || 'http://127.0.0.1:1234');
  } catch {
    throw new Error('Neplatná adresa místního Qwen serveru.');
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.protocol !== 'http:') {
    throw new Error('Prioritu lze upravit pouze u místního HTTP serveru.');
  }
  if (process.platform !== 'win32') {
    return { applied: false, message: 'Automatické omezení priority je dostupné jen ve Windows; nastav CPU vlákna přímo v Qwen serveru.' };
  }
  const port = Number(base.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Neplatný port Qwen serveru.');
  const priority = enabled ? 'BelowNormal' : 'Normal';
  const script = `$ErrorActionPreference='Stop'; $owners=Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -ExpandProperty OwningProcess -Unique; if (-not $owners) { Write-Output 'NO_LISTENER'; exit 0 }; foreach ($owner in $owners) { $p=Get-Process -Id $owner -ErrorAction Stop; $p.PriorityClass='${priority}'; Write-Output $p.PriorityClass }`;
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 5000
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({ applied: false, message: `Prioritu Qwen serveru se nepodařilo změnit: ${(stderr || error.message).trim()}` });
        return;
      }
      if (!stdout.includes(priority)) {
        resolve({ applied: false, message: `Na portu ${port} nebyl nalezen Qwen server; jeho prioritu uprav v nastavení serveru.` });
        return;
      }
      resolve({
        applied: true,
        message: enabled
          ? 'Šetrný režim: Qwen běží s nižší prioritou, aby měl počítač přednost.'
          : 'Šetrný režim vypnut: Qwen běží s normální prioritou.'
      });
    });
  });
});

function readTextExcerpt(file, byteLimit) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(byteLimit);
    const bytes = fs.readSync(fd, buffer, 0, byteLimit, 0);
    return buffer.subarray(0, bytes).toString('utf8').slice(0, MAX_TEXT_CHARS);
  } finally {
    fs.closeSync(fd);
  }
}

const imageTypes = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};
const textTypes = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.xml', '.yaml', '.yml',
  '.html', '.htm', '.css', '.scss', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.kt',
  '.cs', '.cpp', '.c', '.h', '.hpp', '.go', '.rs', '.php', '.rb', '.sh', '.ps1', '.sql',
  '.toml', '.ini', '.env', '.log', '.gitignore', '.dockerfile', '.gradle', '.properties'
]);

function isSensitiveFileName(name) {
  return /^\.env(?:\.|$)/i.test(name) ||
    /(secret|credential|password|token|private[-_]?key|id_rsa)/i.test(name) ||
    /\.(pem|p12|pfx|key)$/i.test(name);
}

function directoryContent(directory) {
  const excerpts = [];
  let filesRead = 0;
  let bytesRead = 0;
  function walk(folder) {
    if (filesRead >= MAX_FOLDER_FILES || bytesRead >= MAX_ARCHIVE_TEXT) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (filesRead >= MAX_FOLDER_FILES || bytesRead >= MAX_ARCHIVE_TEXT) break;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.isSymbolicLink() ||
          isSensitiveFileName(entry.name)) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (entry.isFile() && textTypes.has(path.extname(entry.name).toLowerCase())) {
        const remaining = Math.min(32 * 1024, MAX_ARCHIVE_TEXT - bytesRead);
        const excerpt = readTextExcerpt(file, remaining);
        excerpts.push(`--- ${path.relative(directory.path, file)} ---\n${excerpt}`);
        filesRead++;
        bytesRead += Buffer.byteLength(excerpt, 'utf8');
      }
    }
  }
  walk(directory.path);
  return excerpts.length
    ? `Textové soubory ze složky ${directory.name} (výběr ${filesRead} souborů):\n${excerpts.join('\n\n')}`
    : `Ve složce ${directory.name} nebyly nalezeny podporované textové soubory.`;
}

function zipContent(file, name) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      let output = '';
      let bytesRead = 0;
      let filesRead = 0;
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      zip.on('error', reject);
      zip.on('end', () => finish(output
        ? `Textové soubory z archivu ${name} (výběr ${filesRead} souborů):\n${output}`
        : `V archivu ${name} nebyly nalezeny podporované textové soubory.`));
      zip.on('entry', entry => {
        const entryName = entry.fileName.replace(/\\/g, '/');
        const ext = path.extname(entryName).toLowerCase();
        if (entry.fileName.endsWith('/') || entryName.split('/').some(part => part === '..') ||
            entryName.split('/').some(part => part === 'node_modules' || part === '.git' || isSensitiveFileName(part)) ||
            !textTypes.has(ext) || entry.uncompressedSize > 32 * 1024 ||
            filesRead >= MAX_FOLDER_FILES || bytesRead >= MAX_ARCHIVE_TEXT) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = [];
          let length = 0;
          stream.on('data', chunk => {
            length += chunk.length;
            if (length <= 32 * 1024) chunks.push(chunk);
          });
          stream.on('error', reject);
          stream.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const excerpt = text.slice(0, Math.min(MAX_TEXT_CHARS, MAX_ARCHIVE_TEXT - bytesRead));
            output += `\n--- ${entryName} ---\n${excerpt}\n`;
            bytesRead += Buffer.byteLength(excerpt, 'utf8');
            filesRead++;
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function attachmentContent(attachment) {
  if (attachment.directory) return directoryContent(attachment);
  const file = attachment.path;
  if (attachment.url) return `Odkaz přiložený uživatelem: ${attachment.url}`;
  if (!file) return `[Příloha ${attachment.name || 'soubor'} nemá platnou cestu.]`;
  const stat = fs.statSync(file);
  if (!stat.isFile()) return `[Příloha ${attachment.name}: nejde o soubor.]`;
  if (stat.size > MAX_FILE_SIZE) return `[Příloha ${attachment.name}: přesahuje limit 10 GB.]`;
  if (isSensitiveFileName(path.basename(file))) {
    return `[Příloha ${attachment.name}: tento soubor může obsahovat přihlašovací údaje a nebyl odeslán.]`;
  }

  const ext = path.extname(file).toLowerCase();
  if (ext === '.zip') return zipContent(file, attachment.name);
  if (imageTypes[ext] && stat.size <= MAX_INLINE_FILE_SIZE) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: imageTypes[ext], data: fs.readFileSync(file).toString('base64') }
    };
  }
  if (ext === '.pdf' && stat.size <= MAX_INLINE_FILE_SIZE) {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(file).toString('base64') }
    };
  }
  if (imageTypes[ext] || ext === '.pdf') {
    return `[Příloha ${attachment.name}: pro přímé zpracování AI musí mít nejvýše 5 MB.]`;
  }
  if (!textTypes.has(ext)) {
    return `[Příloha ${attachment.name}: tento binární formát se neposílá do AI. Přilož textový export nebo výňatek.]`;
  }

  const excerpt = readTextExcerpt(file, 128 * 1024);
  const truncated = stat.size > 128 * 1024 || excerpt.length >= MAX_TEXT_CHARS;
  return `Obsah souboru ${attachment.name}${truncated ? ' (zkrácený výňatek)' : ''}:\n${excerpt}`;
}

async function prepareMessages(messages, limits = {}) {
  const recent = messages.slice(-(limits.historyMessages || 10));
  let textBudget = limits.textChars || 48000;
  const inlineByteLimit = limits.inlineBytes || MAX_INLINE_TOTAL_SIZE;
  let inlineBytes = 0;
  const prepared = [];
  for (const message of recent.reverse()) {
    const content = [];
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    for (const attachment of attachments.slice(0, 5)) {
      try {
        const ext = attachment.path ? path.extname(attachment.path).toLowerCase() : '';
        const isInline = !!imageTypes[ext] || ext === '.pdf';
        const stat = attachment.path && !attachment.directory ? fs.statSync(attachment.path) : null;
        if (isInline && stat && inlineBytes + stat.size > inlineByteLimit) {
          content.push({ type: 'text', text: `[Příloha ${attachment.name}: vynechána kvůli limitu velikosti multimodálního požadavku.]` });
          continue;
        }
        const part = await attachmentContent(attachment);
        if (isInline && stat && stat.size <= MAX_INLINE_FILE_SIZE) inlineBytes += stat.size;
        if (typeof part === 'string') {
          const excerpt = textBudget > 0 ? part.slice(0, textBudget) : '';
          textBudget -= excerpt.length;
          if (excerpt) content.push({ type: 'text', text: excerpt });
        } else {
          content.push(part);
        }
      } catch (error) {
        content.push({ type: 'text', text: `[Přílohu ${attachment.name} se nepodařilo načíst: ${error.message}]` });
      }
    }

    const text = `${message.context || ''}\n${message.content || ''}`;
    const boundedText = textBudget > 0 ? text.slice(-Math.min(text.length, textBudget)) : '';
    textBudget -= boundedText.length;
    if (boundedText) content.push({ type: 'text', text: boundedText });
    prepared.push({ role: message.role, content: content.length ? content : text });
  }
  return mergeConsecutiveMessages(prepared.reverse());
}

ipcMain.handle('ai', async (e, { system, messages, model, extendedThinking, webSearch, provider, qwenUrl, qwenEconomy, requestId }) => {
  const previousController = aiRequests.get(e.sender.id);
  if (previousController) previousController.abort();
  const controller = new AbortController();
  const reportProgress = (type, data = {}) => {
    if (typeof requestId === 'string' && requestId && !e.sender.isDestroyed()) {
      e.sender.send('aiProgress', { requestId, type, ...data });
    }
  };
  const timeoutMs = provider === 'qwen' ? QWEN_TIMEOUT_MS : 180000;
  let timedOut = false;
  aiRequests.set(e.sender.id, controller);
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    reportProgress('status', { text: 'Připravuji kontext a přílohy…' });
    const selectedModel = provider === 'qwen'
      ? (typeof model === 'string' ? model.trim() : '')
      : (typeof model === 'string' && model.trim() ? model.trim() : MODEL);
    const useQwenEconomy = provider === 'qwen' && qwenEconomy !== false;
    const preparedMessages = await prepareMessages(
      messages,
      useQwenEconomy ? QWEN_ECONOMY_LIMITS : undefined
    );
    if (provider === 'qwen') {
      const base = new URL(qwenUrl || 'http://127.0.0.1:1234');
      const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
      if (!isLoopback || base.protocol !== 'http:' || base.username || base.password) {
        return { error: 'Qwen bez API klíče musí běžet místně na http://127.0.0.1 nebo http://localhost.' };
      }
      let qwenModel = selectedModel;
      if (!qwenModel) {
        const modelResponse = await fetch(new URL('/v1/models', base), { signal: AbortSignal.timeout(2500) });
        if (!modelResponse.ok) return { error: `Qwen server odpověděl HTTP ${modelResponse.status} při hledání modelu.` };
        const modelData = await modelResponse.json();
        qwenModel = (modelData.data || []).map(item => item.id).find(Boolean) || '';
        if (!qwenModel) return { error: 'Qwen server běží, ale nemá načtený žádný model. Načti Qwen v LM Studio a zkus to znovu.' };
      }
      const qwenMessages = [{ role: 'system', content: system }];
      for (const message of preparedMessages) {
        const parts = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
        const content = parts.flatMap(part => {
          if (part.type === 'text') return [{ type: 'text', text: part.text }];
          if (part.type === 'image' && part.source && part.source.type === 'base64') {
            return [{
              type: 'image_url',
              image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` }
            }];
          }
          if (part.type === 'document') return [{ type: 'text', text: '[PDF přílohy nejsou tímto lokálním Qwen endpointem podporovány.]' }];
          return [];
        });
        const previous = qwenMessages[qwenMessages.length - 1];
        if (previous && previous.role === message.role) {
          previous.content = Array.isArray(previous.content)
            ? previous.content.concat(content)
            : [{ type: 'text', text: previous.content }, ...content];
        } else {
          qwenMessages.push({ role: message.role, content });
        }
      }
      reportProgress('status', { text: 'Qwen začíná odpovídat…' });
      const response = await fetch(new URL('/v1/chat/completions', base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: qwenModel,
          messages: qwenMessages,
          stream: true,
          max_tokens: useQwenEconomy
            ? (extendedThinking ? 2048 : 1536)
            : (extendedThinking ? 8192 : 4096)
        })
      });
      const completion = await readOpenAICompatibleResponse(response, text => reportProgress('delta', { text }));
      if (completion.error) return completion;
      reportProgress('status', { text: 'Odpověď dokončena.' });
      return {
        text: completion.text,
        citations: []
      };
    }

    const key = getKey();
    if (!key) return { error: 'Chybí Anthropic API klíč. V Profilu vyber lokální Qwen server, který nevyžaduje API klíč.' };
    const request = {
      model: selectedModel,
      max_tokens: extendedThinking ? 16000 : 8192,
      system,
      messages: preparedMessages
    };
    if (extendedThinking) request.thinking = { type: 'enabled', budget_tokens: 10000 };
    if (webSearch) {
      request.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
    }

    reportProgress('status', { text: 'Odesílám požadavek do AI…' });
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2026-10-21',
          'content-type': 'application/json'
        },
        signal: controller.signal,
        body: JSON.stringify(request)
      });
      const result = await r.json();
      if (!r.ok) return { error: (result.error && result.error.message) || 'Chyba API' };
      response = result;
      if (result.stop_reason !== 'pause_turn' || attempt === 2) break;
      request.messages.push({ role: 'assistant', content: result.content });
    }
    const textBlocks = (response.content || []).filter(block => block.type === 'text');
    const citations = [];
    for (const block of textBlocks) {
      for (const citation of block.citations || []) {
        if (citation.url && !citations.some(source => source.url === citation.url)) {
          citations.push({ title: citation.title || citation.url, url: citation.url });
        }
      }
    }
    const text = textBlocks.map(block => block.text || '').filter(Boolean).join('\n');
    if (text) reportProgress('delta', { text });
    reportProgress('status', { text: 'Odpověď dokončena.' });
    return {
      text,
      citations
    };
  } catch (error) {
    if (controller.signal.aborted) {
      if (timedOut) {
        reportProgress('status', { text: 'Požadavek vypršel.' });
        return {
          timeout: true,
          error: provider === 'qwen'
            ? 'Qwen pracoval déle než 15 minut. Zkrať zadání, nebo vypni úsporný režim pro plný kontext.'
            : 'Požadavek vypršel po 3 minutách.'
        };
      }
      reportProgress('status', { text: 'Požadavek zastaven.' });
      return { cancelled: true };
    }
    if (provider === 'qwen') {
      return { error: `Nelze dokončit požadavek Qwen: ${error.message || error}. Zkontroluj, že je model načtený a místní server běží.` };
    }
    return { error: String(error.message || error) };
  } finally {
    clearTimeout(timeoutId);
    if (aiRequests.get(e.sender.id) === controller) aiRequests.delete(e.sender.id);
  }
});
