const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');
const FOLDERS = ['data', 'input', 'output', 'thumbnails', 'semantic-models'];
const RESERVE = 10 * 1024 ** 3;
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function freeBytes(root) {
  const stat = fs.statfsSync(root, { bigint: true });
  return Number(stat.bavail * stat.bsize);
}
function inventory(root) {
  const files = [];
  function walk(relative) {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('数据目录含链接，无法安全自动迁移；原目录保持不变。');
    if (stat.isDirectory()) {
      files.push({ relative, size: 0, mtime: stat.mtimeMs, directory: true });
      for (const name of fs.readdirSync(absolute).sort()) walk(path.join(relative, name));
    }
    else if (stat.isFile()) files.push({ relative, size: stat.size, mtime: stat.mtimeMs });
    else throw new Error('数据目录含特殊文件，无法自动迁移。');
  }
  for (const name of FOLDERS) if (fs.existsSync(path.join(root, name))) walk(name);
  return files;
}
function createDataStorage(profileRoot) {
  const configFile = path.join(profileRoot, 'data-location.json');
  // A genuinely new profile is allowed; a configured relocated root is never recreated.
  if (!fs.existsSync(profileRoot)) fs.mkdirSync(profileRoot, { recursive: true });
  let config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : { version: 1, activeRoot: profileRoot };
  if (config.version !== 1 || !path.isAbsolute(config.activeRoot)) throw new Error('数据路径配置无效，已停止启动以保护原数据。');
  function save(next) {
    fs.mkdirSync(profileRoot, { recursive: true });
    const temporary = `${configFile}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next), { flag: 'wx' });
    const descriptor = fs.openSync(temporary, 'r+');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, configFile);
    config = next;
  }
  return {
    root: () => config.activeRoot,
    assertAvailable() {
      if (!fs.existsSync(config.activeRoot)) throw new Error('数据目录不可用，请连接原磁盘；不会创建空白替代目录。');
      if (config.activeRoot !== profileRoot) {
        const marker = JSON.parse(fs.readFileSync(path.join(config.activeRoot, '.t8-data-location.json'), 'utf8'));
        if (!config.activeId || marker.id !== config.activeId || marker.version !== 1) throw new Error('数据目录身份不匹配，已停止启动以保护原数据。');
      }
    },
    status: () => ({ path: config.activeRoot, freeBytes: freeBytes(config.activeRoot), reserveBytes: RESERVE }),
    schedule(parent) {
      const source = fs.realpathSync(config.activeRoot);
      const destinationParent = fs.realpathSync(parent);
      const relative = path.relative(source, destinationParent);
      const reverse = path.relative(destinationParent, source);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
        || !reverse || (!reverse.startsWith(`..${path.sep}`) && reverse !== '..' && !path.isAbsolute(reverse))) {
        throw new Error('请选择原数据目录之外的独立目录。');
      }
      const files = inventory(source);
      const required = files.reduce((sum, file) => sum + file.size, RESERVE);
      if (freeBytes(destinationParent) < required) throw new Error(`目标盘空间不足：需要至少 ${(required / 1024 ** 3).toFixed(2)} GiB（含迁移数据和 10 GiB 安全余量）。`);
      const target = path.join(destinationParent, `T8-PenguinCanvas-data-${crypto.randomUUID()}`);
      save({ ...config, pending: { source, target } });
      return target;
    },
    async migrate(onProgress = () => {}) {
      const pending = config.pending;
      if (!pending) return;
      if (pending.source !== fs.realpathSync(config.activeRoot) || !path.isAbsolute(pending.target)
        || !path.basename(pending.target).startsWith('T8-PenguinCanvas-data-')) throw new Error('迁移计划无效，原数据未修改。');
      const files = inventory(pending.source);
      const parent = path.dirname(pending.target);
      if (freeBytes(parent) < files.reduce((sum, file) => sum + file.size, RESERVE)) throw new Error('目标盘空间不足，请释放空间后重启；原数据未修改。');
      // Every retry uses a fresh staging directory; interrupted copies are never treated as authoritative.
      const staging = `${pending.target}.partial-${crypto.randomUUID()}`;
      fs.mkdirSync(staging);
      let completed = 0;
      onProgress({ completed, total: files.length });
      for (const file of files) {
        const source = path.join(pending.source, file.relative);
        const target = path.join(staging, file.relative);
        if (file.directory) { fs.mkdirSync(target, { recursive: true }); completed += 1; continue; }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
        const handle = await fs.promises.open(target, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        if (await digest(source) !== await digest(target)) throw new Error('迁移校验失败，原数据未修改。');
        const stat = fs.statSync(source);
        if (stat.size !== file.size || stat.mtimeMs !== file.mtime) throw new Error('迁移期间原数据发生变化，已停止切换目录。');
        completed += 1;
        onProgress({ completed, total: files.length });
      }
      if (JSON.stringify(inventory(pending.source)) !== JSON.stringify(files)) throw new Error('原数据目录发生变化，已停止迁移。');
      // A pre-existing destination is never overwritten, even after an interrupted pointer update.
      if (fs.existsSync(pending.target)) throw new Error('目标目录已经存在，原数据保持不变，请重新选择目录。');
      const activeId = crypto.randomUUID();
      const marker = fs.openSync(path.join(staging, '.t8-data-location.json'), 'wx');
      try { fs.writeFileSync(marker, JSON.stringify({ version: 1, id: activeId })); fs.fsyncSync(marker); }
      finally { fs.closeSync(marker); }
      fs.renameSync(staging, pending.target);
      save({ version: 1, activeRoot: pending.target, activeId });
    },
  };
}
module.exports = { createDataStorage, inventory, RESERVE };
