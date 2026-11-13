const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { saveProjectFile } = require('../project-files');

async function withProject(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-ai-project-'));
  try {
    await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('creates the requested nested directory structure and writes the file', async () => {
  await withProject(async root => {
    const result = await saveProjectFile(root, root, 'src\\main\\java\\App.java', 'class App {}');

    assert.equal(result.relativePath, 'src/main/java/App.java');
    assert.equal(fs.readFileSync(path.join(root, 'src', 'main', 'java', 'App.java'), 'utf8'), 'class App {}');
  });
});

test('saves a plain filename into the selected project subfolder', async () => {
  await withProject(async root => {
    const selectedFolder = path.join(root, 'config');
    fs.mkdirSync(selectedFolder);
    const result = await saveProjectFile(root, selectedFolder, 'plugin.yml', 'name: Example');

    assert.equal(result.relativePath, 'plugin.yml');
    assert.equal(fs.readFileSync(path.join(selectedFolder, 'plugin.yml'), 'utf8'), 'name: Example');
  });
});

test('rejects traversal and absolute generated paths without writing outside the project', async () => {
  await withProject(async root => {
    const outside = path.join(path.dirname(root), 'outside.txt');

    await assert.rejects(saveProjectFile(root, root, '../outside.txt', 'bad'), /neplatnou cestu/i);
    await assert.rejects(saveProjectFile(root, root, path.resolve(outside), 'bad'), /neplatnou cestu/i);
    assert.equal(fs.existsSync(outside), false);
  });
});

test('does not overwrite an existing file unless explicitly confirmed', async () => {
  await withProject(async root => {
    const file = path.join(root, 'config.yml');
    fs.writeFileSync(file, 'original');
    let promptedPath = '';

    const cancelled = await saveProjectFile(root, root, 'config.yml', 'replacement', async relativePath => {
      promptedPath = relativePath;
      return false;
    });
    assert.equal(cancelled, null);
    assert.equal(promptedPath, 'config.yml');
    assert.equal(fs.readFileSync(file, 'utf8'), 'original');

    await saveProjectFile(root, root, 'config.yml', 'replacement', async () => true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'replacement');
  });
});
