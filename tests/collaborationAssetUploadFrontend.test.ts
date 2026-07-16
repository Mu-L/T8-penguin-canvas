import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const upload = read('src/components/CollaborationAssetUpload.tsx');
const workspace = read('src/components/CollaborationWorkspace.tsx');

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('collaboration upload UI is mounted only behind the uploadAsset capability', () => {
  assert.match(workspace, /const canUploadAsset = session\?\.capabilities\.includes\('uploadAsset'\) \|\| false;/);
  assert.match(workspace, /\{canUploadAsset && <CollaborationAssetUpload onStatus=/);
  assert.equal((workspace.match(/<CollaborationAssetUpload\b/g) || []).length, 1);

  const capabilityCheck = workspace.indexOf("capabilities.includes('uploadAsset')");
  const uploadMount = workspace.indexOf('{canUploadAsset && <CollaborationAssetUpload');
  assert.ok(capabilityCheck >= 0 && capabilityCheck < uploadMount, 'capability must be derived before the guarded mount');
});

test('initial canvas synchronization leaves joining to websocket open with the session scope', () => {
  const loadCanvas = section(workspace, 'const loadCanvas = useCallback', 'const loadSubflows = useCallback');
  assert.doesNotMatch(loadCanvas, /canvas\.join|webSocketRef\.current/);
  assert.match(workspace, /socket\.onopen = \(\) => socket\.send\(JSON\.stringify\(\{ type: 'canvas\.join', canvasId: session\.canvasId \}\)\)/);
  assert.doesNotMatch(workspace, /webSocketRef\.current\?\.send\(JSON\.stringify\(\{ type: 'canvas\.join'/);
});

test('collaboration upload uses exact 8 MiB non-overlapping ranges and required integrity headers', () => {
  assert.match(upload, /COLLABORATION_UPLOAD_CHUNK_SIZE = 8 \* 1024 \* 1024/);
  assert.match(upload, /const start = index \* COLLABORATION_UPLOAD_CHUNK_SIZE;/);
  assert.match(upload, /const end = Math\.min\(current\.file\.size, start \+ COLLABORATION_UPLOAD_CHUNK_SIZE\);/);
  assert.match(upload, /'Content-Type': 'application\/octet-stream'/);
  assert.match(upload, /'Content-Range': `bytes \$\{start\}-\$\{end - 1\}\/\$\{current\.file\.size\}`/);
  assert.match(upload, /'X-Chunk-SHA256': chunkHash/);
  assert.match(upload, /body: chunk/);

  const chunkSize = 8 * 1024 * 1024;
  const ranges = (size: number) => Array.from({ length: Math.ceil(size / chunkSize) }, (_, index) => {
    const start = index * chunkSize;
    const endExclusive = Math.min(size, start + chunkSize);
    return [start, endExclusive - 1, endExclusive - start];
  });
  assert.deepEqual(ranges(chunkSize - 1), [[0, chunkSize - 2, chunkSize - 1]]);
  assert.deepEqual(ranges(chunkSize), [[0, chunkSize - 1, chunkSize]]);
  assert.deepEqual(ranges(chunkSize + 1), [[0, chunkSize - 1, chunkSize], [chunkSize, chunkSize, 1]]);
  assert.deepEqual(ranges(chunkSize * 2), [[0, chunkSize - 1, chunkSize], [chunkSize, chunkSize * 2 - 1, chunkSize]]);
});

test('collaboration upload covers policy, create, reconcile, chunk, complete, and cancel contracts', () => {
  assert.match(upload, /'\/api\/collab\/assets\/uploads\/policy'/);
  assert.match(upload, /collaborationUploadRequest<unknown>\('\/api\/collab\/assets\/uploads', \{/);
  assert.match(upload, /filename: task\.file\.name/);
  assert.match(upload, /size: task\.file\.size/);
  assert.match(upload, /mimeType: task\.file\.type \|\| 'application\/octet-stream'/);
  assert.match(upload, /contentHash: task\.contentHash/);
  assert.match(upload, /idempotencyKey: task\.idempotencyKey/);
  assert.match(upload, /phase: 'creating', sessionRequested: true/);
  assert.match(upload, /`\/api\/collab\/assets\/uploads\/\$\{encodeURIComponent\(current\.sessionId\)\}`/);
  assert.match(upload, /`\/api\/collab\/assets\/uploads\/\$\{encodeURIComponent\(identity\.sessionId!\)\}\/chunks\/\$\{index\}`/);
  assert.match(upload, /`\/api\/collab\/assets\/uploads\/\$\{encodeURIComponent\(identity\.sessionId\)\}\/pause`/);
  assert.match(upload, /`\/api\/collab\/assets\/uploads\/\$\{encodeURIComponent\(identity\.sessionId!\)\}\/resume`/);
  assert.match(upload, /`\/api\/collab\/assets\/uploads\/\$\{encodeURIComponent\(identity\.sessionId!\)\}\/complete`/);
  assert.match(upload, /body: JSON\.stringify\(\{ contentHash: current\.contentHash \}\)/);
  assert.match(upload, /method: 'DELETE'/);
  assert.match(upload, /credentials: 'same-origin'/);

  const execute = section(upload, 'const executeUpload = useCallback', 'const selectFile = useCallback');
  const statusRequest = execute.indexOf('if (current.sessionId)');
  const serverResume = execute.indexOf("if (serverState === 'paused')");
  const missingChunkLoop = execute.indexOf('for (let index = 0; index < totalChunks; index += 1)');
  const completionRequest = execute.indexOf('/complete`');
  assert.ok(statusRequest >= 0 && statusRequest < missingChunkLoop, 'resume must reconcile before sending chunks');
  assert.ok(serverResume >= 0 && serverResume < missingChunkLoop, 'a server-paused session must be resumed before sending chunks');
  assert.ok(missingChunkLoop >= 0 && missingChunkLoop < completionRequest, 'complete must follow all missing chunks');
  assert.match(execute, /if \(received\.has\(index\)\) continue;/);
  assert.match(execute, /if \(serverState === 'paused'\) throw new Error\('服务器上传会话仍处于暂停状态，请重试继续'\);/);
});

test('upload response adapters accept gateway policy, direct session, nested completion, quota, and CAS reuse shapes', () => {
  assert.match(upload, /source\.maxFileBytes \?\? source\.maxUploadBytes/);
  assert.match(upload, /source\.sessionId \|\| source\.id \|\| outer\.sessionId/);
  assert.match(upload, /outer\.session \|\| outer\.upload \|\| value/);
  assert.match(upload, /outer\.asset as AssetRef \| undefined/);
  assert.match(upload, /outer\.deduplicated \?\? session\?\.reused/);
  assert.match(upload, /const project = normalizeQuotaScope\(source\.project\);/);
  assert.match(upload, /const member = source\.member === null \? null : normalizeQuotaScope\(source\.member\);/);
  assert.match(upload, /Object\.prototype\.hasOwnProperty\.call\(record, 'data'\) \? record\.data : payload/);
});

test('pause, resume, cancel, and late responses are guarded by session plus client generation', () => {
  assert.match(upload, /left\.sessionId === right\.sessionId && left\.generation === right\.generation/);
  assert.match(upload, /snapshot\.sessionId !== identity\.sessionId/);
  assert.match(upload, /if \(!current \|\| !sameIdentity\(current, identity\)\) return false;/);
  assert.match(upload, /if \(!isCurrent\(identity\)\) return;/);
  assert.match(upload, /if \(runControllerRef\.current === controllerEntry\) runControllerRef\.current = null;/);
  assert.ok((upload.match(/\+\+generationRef\.current/g) || []).length >= 4, 'select, pause, resume, and cancel must advance generation');

  const pause = section(upload, 'const pauseUpload = useCallback', 'const resumeUpload = useCallback');
  assert.match(pause, /runControllerRef\.current\?\.controller\.abort\(\)/);
  assert.match(pause, /const generation = \+\+generationRef\.current/);
  assert.match(pause, /phase: 'pausing'/);
  assert.match(pause, /phase: 'paused'/);
  assert.match(pause, /encodeURIComponent\(identity\.sessionId\)\}\/pause/);
  assert.match(pause, /snapshot = normalizeSession\(await collaborationUploadRequest<unknown>/);
  assert.match(pause, /if \(!isCurrent\(identity\) \|\| !acceptServerSnapshot\(identity, snapshot\)\) return;/);

  const resume = section(upload, 'const resumeUpload = useCallback', 'const cancelUpload = useCallback');
  assert.match(resume, /const generation = \+\+generationRef\.current/);
  assert.match(resume, /phase: current\.sessionId \? 'checking' : 'hashing'/);
  assert.match(resume, /executeUpload\(\{ sessionId: next\.sessionId, generation \}\)/);

  const cancel = section(upload, 'const cancelUpload = useCallback', 'const clearTask = useCallback');
  assert.match(cancel, /runControllerRef\.current\?\.controller\.abort\(\)/);
  assert.match(cancel, /const identity = \{ sessionId: current\.sessionId, generation \}/);
  assert.match(cancel, /if \(!sessionId && current\.sessionRequested && current\.contentHash\)/);
  assert.match(cancel, /body: JSON\.stringify\(createSessionRequest\(current\)\)/);
  assert.match(cancel, /sessionId = recovered\.sessionId;/);
  assert.match(cancel, /encodeURIComponent\(sessionId\)/);
  assert.match(cancel, /updateTask\(identity,/);
  assert.match(cancel, /if \(!isCurrent\(identity\)\) return;/);

  const replay = cancel.indexOf('if (!sessionId && current.sessionRequested && current.contentHash)');
  const deletion = cancel.indexOf("method: 'DELETE'");
  const staleGuard = cancel.indexOf('if (!isCurrent(identity)) return;');
  assert.ok(replay >= 0 && replay < deletion, 'unknown create response must be recovered before DELETE');
  assert.ok(deletion >= 0 && deletion < staleGuard, 'server cleanup must finish even if a newer UI generation supersedes the task');
});

test('browser hashing and upload keep file reads bounded to one 8 MiB slice', () => {
  const hashing = section(upload, 'async function hashFileByChunks', 'function phaseLabel');
  assert.match(hashing, /for \(let start = 0; start < file\.size; start \+= COLLABORATION_UPLOAD_CHUNK_SIZE\)/);
  assert.match(hashing, /file\.slice\(start, end\)\.arrayBuffer\(\)/);
  assert.match(hashing, /wholeFileHash\.update\(bytes\)/);
  assert.match(hashing, /chunkHashes\.push\(sha256Hex\(bytes\)\)/);
  assert.doesNotMatch(hashing, /file\.arrayBuffer\(\)/);
  assert.doesNotMatch(hashing, /Promise\.all|\.concat\(bytes\)|\.push\(\.\.\.bytes\)/);
});
