import { readFile } from 'node:fs/promises';

import ts from 'typescript';

const TYPESCRIPT_MODULE_PATTERN = /\.[cm]?tsx?$/i;

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !TYPESCRIPT_MODULE_PATTERN.test(new URL(url).pathname)) {
    return nextLoad(url, context);
  }

  const source = await readFile(new URL(url), 'utf8');
  const output = ts.transpileModule(source, {
    fileName: new URL(url).pathname,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      sourceMap: true,
      inlineSources: true,
    },
  });

  return {
    format: 'module',
    shortCircuit: true,
    source: output.outputText,
  };
}
