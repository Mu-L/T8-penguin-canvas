export type ReusableGenerationNodeKind =
  | 'image'
  | 'video'
  | 'seedance'
  | 'audio'
  | 'runninghub'
  | 'rh-tools'
  | 'rh-toolbox';

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function listHasUrl(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => {
    if (nonEmptyString(item)) return true;
    if (!item || typeof item !== 'object') return false;
    const record = item as Record<string, unknown>;
    return [
      record.url,
      record.sourceUrl,
      record.imageUrl,
      record.videoUrl,
      record.audioUrl,
      record.dataUrl,
    ].some(nonEmptyString);
  });
}

function hasMediaResult(
  data: Record<string, unknown>,
  singularFields: string[],
  pluralFields: string[],
): boolean {
  return singularFields.some((field) => nonEmptyString(data[field]))
    || pluralFields.some((field) => listHasUrl(data[field]));
}

/**
 * Only recognizes fields that are actual downstream outputs for the requested
 * generation node. Prompts, task ids and Provider metadata never qualify.
 */
export function hasReusableGenerationResult(
  kind: ReusableGenerationNodeKind,
  value: unknown,
): boolean {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (kind === 'image') {
    return hasMediaResult(data, ['imageUrl'], ['imageUrls', 'generatedImages', 'outputImages']);
  }
  if (kind === 'video' || kind === 'seedance') {
    return hasMediaResult(data, ['videoUrl'], ['videoUrls', 'outputVideos']);
  }
  if (kind === 'audio') {
    return hasMediaResult(data, ['audioUrl'], ['audioUrls', 'tracks', 'outputAudios']);
  }
  if (kind === 'rh-toolbox' && nonEmptyString(data.outputText)) return true;
  return hasMediaResult(
    data,
    ['imageUrl', 'videoUrl', 'audioUrl'],
    ['urls', 'imageUrls', 'videoUrls', 'audioUrls', 'tracks', 'outputImages', 'outputVideos', 'outputAudios'],
  );
}

export function shouldReuseGenerationResult(
  kind: ReusableGenerationNodeKind,
  value: unknown,
): boolean {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return data.reuseResult === true && hasReusableGenerationResult(kind, data);
}
