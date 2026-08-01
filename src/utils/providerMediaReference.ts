const PROVIDER_UPLOAD_LOCAL_MEDIA_RE =
  /^\/(?:files\/(?:input|output|thumbnails)\/|input\/|output\/|api\/resources\/(?:file|set-file)\/|api\/project-assets\/[^/?#]+\/media(?:[/?#]|$))/;

/**
 * References that still point at T8-managed or remote media and therefore
 * must be uploaded to the provider before a workflow field is submitted.
 *
 * RunningHub fields ultimately require the provider's physical fileName. A
 * T8 resource URL such as /api/resources/file/:id is never a valid RH
 * fileName even though it does not have a file extension.
 */
export function isProviderUploadMediaReference(value: unknown): boolean {
  const text = String(value ?? '').trim();
  if (!text) return false;
  if (/^https?:\/\//i.test(text)) return true;
  return PROVIDER_UPLOAD_LOCAL_MEDIA_RE.test(text);
}
