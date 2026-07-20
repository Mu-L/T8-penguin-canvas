import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
const database = fs.readFileSync(
  path.join(root, 'backend', 'src', 'services', 'projectDatabase.js'),
  'utf8',
);

test('Electron acquires the single-instance lock before any backend or window lifecycle can start', () => {
  const lock = main.indexOf('app.requestSingleInstanceLock()');
  const commandLine = main.indexOf("app.commandLine.appendSwitch('disable-features'");
  const backend = main.indexOf('async function startBackend()');
  const ready = main.indexOf('app.whenReady().then(async () =>');
  assert.ok(lock > 0);
  assert.ok(lock < commandLine);
  assert.ok(lock < backend);
  assert.ok(lock < ready);
  assert.match(main, /if \(!ELECTRON_SINGLE_INSTANCE_OWNER\) app\.quit\(\);/);
  assert.match(main, /if \(!ELECTRON_SINGLE_INSTANCE_OWNER \|\| electronQuitRequested\) return;[\s\S]*backendStartPromise = startBackend\(\);/);
});

test('the owning Electron process restores and focuses its existing window for a second launch', () => {
  assert.match(main, /app\.on\('second-instance', \(\) => \{[\s\S]*mainWindow\.isMinimized\(\)[\s\S]*mainWindow\.restore\(\)[\s\S]*mainWindow\.show\(\)[\s\S]*mainWindow\.focus\(\)/);
  assert.match(main, /app\.on\('before-quit', \(event\) => \{[\s\S]*if \(!ELECTRON_SINGLE_INSTANCE_OWNER\) return;[\s\S]*event\.preventDefault\(\)/);
});

test('ProjectDatabase holds an independent directory guard until after the primary handle closes', () => {
  assert.match(database, /PROJECT_DATABASE_OWNER_GUARD_BASENAME = '\.t8-project-database-owner\.sqlite3'/);
  assert.match(database, /locking_mode = EXCLUSIVE/);
  assert.match(database, /guard\.exec\('BEGIN EXCLUSIVE'\)/);
  assert.match(database, /project_database_owner_conflict/);
  const close = database.indexOf('close() {');
  const primaryClose = database.indexOf('if (this.db?.open) this.db.close();', close);
  const ownerRelease = database.indexOf('releaseProjectDatabaseOwner(this.projectDatabaseOwner);', primaryClose);
  assert.ok(close > 0 && primaryClose > close && ownerRelease > primaryClose);
});
