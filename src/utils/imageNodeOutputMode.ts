const IMAGE_OUTPUT_NODE_TYPES = new Set(['image', 'edit']);

/**
 * ImageNode keeps its prompt in node data for reruns and prompt metadata, but its
 * public output contract is image-only unless the user explicitly opts back in.
 * Missing data is treated as the new default so existing saved canvases migrate
 * without rewriting their documents.
 */
export function shouldCollectNodeTextOutput(nodeType: unknown, data: unknown): boolean {
  if (!IMAGE_OUTPUT_NODE_TYPES.has(String(nodeType || ''))) return true;
  if (!data || typeof data !== 'object') return false;
  return (data as Record<string, unknown>).imageOnlyOutput === false;
}
