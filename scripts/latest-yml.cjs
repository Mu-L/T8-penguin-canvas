'use strict';

const yaml = require('js-yaml');

function parseLatestYaml(text) {
  let data;
  try {
    data = yaml.load(String(text ?? ''), {
      json: false,
      filename: 'latest.yml',
    });
  } catch (error) {
    throw new Error(`latest.yml YAML parse failed: ${error?.message || String(error)}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('latest.yml root must be a mapping');
  }
  return data;
}

function exactTopLevelVersion(text, expectedVersion) {
  try {
    const data = parseLatestYaml(text);
    return Object.prototype.hasOwnProperty.call(data, 'version')
      && typeof data.version === 'string'
      && data.version === String(expectedVersion);
  } catch (_) {
    return false;
  }
}

function latestInstallerMetadataFromData(data, installerName) {
  if (!Object.prototype.hasOwnProperty.call(data, 'files')
    || !Array.isArray(data.files)
    || data.files.length !== 1) {
    throw new Error('latest.yml NSIS files sequence must contain exactly one entry');
  }
  const [entry] = data.files;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('latest.yml files entry must be a mapping');
  }
  if (!Object.prototype.hasOwnProperty.call(entry, 'url')
    || typeof entry.url !== 'string'
    || entry.url !== installerName) {
    throw new Error(`latest.yml files entry is missing or duplicated for ${installerName}`);
  }
  if (!Object.prototype.hasOwnProperty.call(entry, 'sha512')
    || typeof entry.sha512 !== 'string'
    || !entry.sha512) {
    throw new Error('latest.yml installer sha512 is missing');
  }
  if (!Object.prototype.hasOwnProperty.call(entry, 'size')
    || !Number.isSafeInteger(entry.size)
    || entry.size <= 0) {
    throw new Error('latest.yml installer size is invalid');
  }
  return {
    sha512: entry.sha512,
    size: entry.size,
  };
}

function latestInstallerMetadata(text, installerName) {
  return latestInstallerMetadataFromData(parseLatestYaml(text), installerName);
}

function assertLatestYamlArtifact({
  text,
  version,
  installerName,
  installerSha512,
  installerSize,
  label = 'latest.yml',
}) {
  const data = parseLatestYaml(text);
  if (!Object.prototype.hasOwnProperty.call(data, 'version')
    || typeof data.version !== 'string'
    || data.version !== String(version)) {
    throw new Error(`${label} version mismatch, expected ${version}`);
  }
  if (!Object.prototype.hasOwnProperty.call(data, 'path')
    || typeof data.path !== 'string'
    || data.path !== installerName) {
    throw new Error(`${label} top-level path mismatch`);
  }
  if (!Object.prototype.hasOwnProperty.call(data, 'sha512')
    || typeof data.sha512 !== 'string'
    || data.sha512 !== installerSha512) {
    throw new Error(`${label} top-level sha512 mismatch`);
  }
  const metadata = latestInstallerMetadataFromData(data, installerName);
  if (metadata.sha512 !== installerSha512) {
    throw new Error(`${label} installer sha512 mismatch`);
  }
  if (metadata.size !== installerSize) {
    throw new Error(`${label} installer size mismatch`);
  }
  return metadata;
}

module.exports = {
  assertLatestYamlArtifact,
  exactTopLevelVersion,
  latestInstallerMetadata,
  parseLatestYaml,
};
