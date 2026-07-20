import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const drawingBoard = readFileSync('src/components/nodes/DrawingBoardNode.tsx', 'utf8');
const imageEdit = readFileSync('src/components/nodes/ImageEditModal.tsx', 'utf8');
const editorCutout = readFileSync('src/utils/rhImageEditorCutout.ts', 'utf8');

test('drawing board queues RH cutout through its exact secondary action Run and replaces only the bound element', () => {
  assert.doesNotMatch(drawingBoard, /runRhImageCutout/);
  assert.match(drawingBoard, /const \[rhCutoutRunning, setRhCutoutRunning\] = useState\(false\)/);
  assert.match(drawingBoard, /const applyRhCutoutToSelectedImage = useCallback\(\(\) => \{/);
  assert.match(drawingBoard, /queueSecondaryAction\(\{[\s\S]*actionId: 'rh-image\.editor-cutout'[\s\S]*imageUrl: source\.url[\s\S]*surface: 'drawing-board'/);
  assert.match(drawingBoard, /registerSecondaryProviderActionExecutor\([\s\S]*'rh-image\.editor-cutout'[\s\S]*'editor-cutout'/);
  assert.match(drawingBoard, /assertTargetCurrent: resolveBoundTarget/);
  assert.match(drawingBoard, /element\.id === source\.id && element\.kind === 'image' && element\.url === params\.imageUrl[\s\S]*url: result\.outputUrl[\s\S]*name: `\$\{source\.name \|\| '图片'\} RH抠图`/);
  assert.match(drawingBoard, /setSelectedElementId\(source\.id\)/);
  assert.equal(drawingBoard.match(/useRunTrigger\(/g)?.length, 1);
  assert.match(drawingBoard, /resolveSecondaryProviderActionForRun/);
  assert.match(drawingBoard, /executeRegisteredSecondaryProviderAction/);
  assert.match(drawingBoard, /title=\{selectedCutoutSource \? '调用 RH工具箱自动抠图并替换选中图片' : '请先选中一张图片'\}/);
});

test('image edit modal requires a persistent owner and executes RH cutout only for the bound image or compose layer', () => {
  assert.doesNotMatch(imageEdit, /runRhImageCutout/);
  assert.match(imageEdit, /const \[workingSrcUrl, setWorkingSrcUrl\] = useState\(srcUrl\)/);
  assert.match(imageEdit, /const selectedComposeImageLayer = useMemo\(\(\) => \{/);
  assert.match(imageEdit, /function applyRhCutoutToCurrentImage\(\) \{/);
  assert.match(imageEdit, /RH抠图需要所属持久画布节点，已停止调用 Provider/);
  assert.match(imageEdit, /const sourceUrl = selectedComposeImageLayer\?\.src \|\| workingSrcUrl/);
  assert.match(imageEdit, /queueSecondaryAction\(\{[\s\S]*actionId: 'rh-image\.editor-cutout'[\s\S]*imageUrl: sourceUrl[\s\S]*surface: 'image-edit-modal'/);
  assert.match(imageEdit, /registerSecondaryProviderActionExecutor\([\s\S]*'rh-image\.editor-cutout'[\s\S]*'editor-cutout'/);
  assert.match(imageEdit, /assertTargetCurrent: resolveBoundTarget/);
  assert.match(imageEdit, /layer\.id === target\.layer\.id && layer\.src === params\.imageUrl[\s\S]*src: result\.outputUrl[\s\S]*name: `\$\{target\.layer\.name \|\| '图层'\} RH抠图`/);
  assert.match(imageEdit, /setWorkingSrcUrl\(result\.outputUrl\)/);
  assert.match(imageEdit, /!hasSecondaryActionOwner/);
  assert.match(imageEdit, /<Scissors size=\{13\} \/> RH抠图/);
  assert.match(editorCutout, /runRhImageCapabilityBatch/);
  assert.doesNotMatch(editorCutout, /runRhImageCutout/);
});
