const fs = require('fs');
const path = require('path');

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function saveProjectFile(projectRoot, parentPath, name, content, confirmOverwrite) {
  if (typeof projectRoot !== 'string' || !projectRoot) throw new Error('Nejprve otevři složku projektu.');
  if (typeof parentPath !== 'string' || !parentPath) throw new Error('Neplatná cesta ke složce.');
  if (typeof content !== 'string') throw new Error('Obsah souboru není platný text.');

  const root = fs.realpathSync(projectRoot);
  const requestedParent = path.resolve(parentPath);
  if (!isWithin(root, requestedParent)) throw new Error('Cesta musí zůstat uvnitř otevřené složky.');
  const parent = fs.realpathSync(requestedParent);
  if (!isWithin(root, parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error('Vybraná cesta není složka projektu.');
  }

  const relativePath = String(name || '').trim().replace(/\\/g, '/');
  const segments = relativePath.split('/');
  if (!relativePath || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) ||
      segments.some(segment => !segment || segment === '.' || segment === '..' || /[<>:"|?*\x00-\x1f]/.test(segment))) {
    throw new Error('AI navrhla neplatnou cestu k souboru.');
  }

  let targetParent = parent;
  for (const directoryName of segments.slice(0, -1)) {
    const directoryPath = path.resolve(targetParent, directoryName);
    if (!isWithin(root, directoryPath)) throw new Error('Cílová složka musí zůstat uvnitř otevřeného projektu.');
    try {
      fs.mkdirSync(directoryPath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    targetParent = fs.realpathSync(directoryPath);
    if (!isWithin(root, targetParent) || !fs.statSync(targetParent).isDirectory()) {
      throw new Error(`Cílová cesta „${directoryName}“ není složka projektu.`);
    }
  }

  const fileName = segments[segments.length - 1];
  const target = path.resolve(targetParent, fileName);
  if (!isWithin(root, target)) throw new Error('Cílový soubor musí zůstat uvnitř otevřeného projektu.');
  const savedRelativePath = path.relative(parent, target).split(path.sep).join('/');
  let overwrite = false;
  try {
    const existing = fs.lstatSync(target);
    if (existing.isSymbolicLink()) throw new Error('Nelze přepsat symbolický odkaz.');
    if (!existing.isFile()) throw new Error('Soubor se stejným názvem už existuje jako složka.');
    if (typeof confirmOverwrite !== 'function' || !(await confirmOverwrite(savedRelativePath))) return null;
    overwrite = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  fs.writeFileSync(target, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
  return {
    path: target,
    name: path.basename(target),
    relativePath: savedRelativePath
  };
}

module.exports = { saveProjectFile };
