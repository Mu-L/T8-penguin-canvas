'use strict';

function parseArgs(argv) {
  const positionals = [];
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index]);
    if (!value.startsWith('-')) {
      positionals.push(value);
      continue;
    }
    if (value === '--human') {
      flags.set('human', true);
      continue;
    }
    if (value === '--json') {
      flags.set('human', false);
      continue;
    }
    if (value === '--version' || value === '-v') {
      flags.set('version', true);
      continue;
    }
    if (value === '--help' || value === '-h') {
      flags.set('help', true);
      continue;
    }
    if ([
      '--complete', '--plan-only', '--only-missing', '--only-failed', '--only-unlocked',
      '--once', '--follow',
    ].includes(value)) {
      flags.set(value.slice(2), true);
      continue;
    }
    if (value === '--instance') {
      const next = String(argv[index + 1] || '').trim();
      if (!next || next.startsWith('-')) {
        const error = new Error('--instance 必须提供 instanceId');
        error.code = 'USAGE_ERROR';
        throw error;
      }
      flags.set('instance', next);
      index += 1;
      continue;
    }
    if ([
      '--name', '--scopes', '--project', '--canvas', '--type', '--kind', '--node', '--file',
      '--patch', '--revision', '--target', '--query', '--asset', '--cursor', '--limit', '--offset',
      '--operation', '--approval', '--intent', '--mode', '--candidates', '--run',
      '--plan', '--scope', '--provider', '--model', '--lock', '--story', '--shot', '--candidate',
      '--to', '--out', '--template', '--prompt', '--goal', '--title', '--audience', '--format',
      '--duration', '--ratio', '--style', '--quality', '--language', '--profile', '--label', '--group',
      '--llm-provider', '--llm-model', '--image-provider', '--image-model',
      '--video-provider', '--video-model', '--audio-provider', '--audio-model',
      '--audio-task', '--voice', '--speaker', '--output-format', '--sample-rate',
      '--speech-rate', '--loudness-rate', '--pitch-rate',
      '--interval-ms', '--timeout',
      '--session', '--recipe', '--bundle', '--sha256', '--trust-policy', '--digest',
      '--source', '--source-handle', '--target-handle', '--edge', '--nodes', '--x', '--y', '--count', '--scale',
      '--from',
    ].includes(value)) {
      const next = String(argv[index + 1] || '').trim();
      if (!next || next.startsWith('-')) {
        const error = new Error(`${value} 必须提供值`);
        error.code = 'USAGE_ERROR';
        throw error;
      }
      flags.set(value.slice(2), next);
      index += 1;
      continue;
    }
    const error = new Error(`未知参数：${value}`);
    error.code = 'USAGE_ERROR';
    throw error;
  }
  return { positionals, flags };
}

module.exports = { parseArgs };
