'use strict';

const crypto = require('node:crypto');

function canonicalTextBytes(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
  return Buffer.from(text.replace(/\r\n?/g, '\n'), 'utf8');
}

function sha256CanonicalText(value) {
  return crypto.createHash('sha256').update(canonicalTextBytes(value)).digest('hex');
}

module.exports = {
  canonicalTextBytes,
  sha256CanonicalText,
};
