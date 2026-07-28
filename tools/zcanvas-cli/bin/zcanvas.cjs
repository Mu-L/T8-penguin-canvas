#!/usr/bin/env node
'use strict';

const { runCli } = require('../src/cli.cjs');

runCli(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error) => {
    process.stderr.write(`zcanvas fatal: ${error?.message || String(error)}\n`);
    process.exitCode = 9;
  },
);
