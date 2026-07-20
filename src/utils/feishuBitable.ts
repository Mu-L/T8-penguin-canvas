export const FEISHU_OPEN_API_CN = 'https://open.feishu.cn';
export const FEISHU_OPEN_API_GLOBAL = 'https://open.larksuite.com';

export type FeishuBitableMediaKind = 'image' | 'video' | 'audio' | 'file';

export interface FeishuBitableParsedLink {
  appToken?: string;
  tableId?: string;
  viewId?: string;
  host?: string;
}

export interface FeishuBitableFieldInfo {
  id: string;
  name: string;
  type: string;
  rawType?: string | number;
  isPrimary?: boolean;
  property?: Record<string, any>;
}

export interface FeishuBitableMedia {
  kind: FeishuBitableMediaKind;
  name: string;
  fileToken?: string;
  url?: string;
  size?: number;
  mimeType?: string;
  fieldName?: string;
}

export interface FeishuBitableNormalizedRecord {
  recordId: string;
  appToken?: string;
  tableId?: string;
  fields: Record<string, any>;
  rowData: Record<string, any>;
  texts: string[];
  media: FeishuBitableMedia[];
  attachments: FeishuBitableMedia[];
}

export type FeishuBitableMappingSource =
  | 'firstText'
  | 'allText'
  | 'images'
  | 'videos'
  | 'audios'
  | 'allMedia'
  | 'status'
  | 'error'
  | 'metadataJson'
  | 'rowDataJson'
  | 'static';

export interface FeishuBitableFieldMapping {
  targetField: string;
  targetType?: string | number;
  source: FeishuBitableMappingSource;
  staticValue?: string;
}

export interface FeishuBitableWriteMedia {
  kind: Exclude<FeishuBitableMediaKind, 'file'>;
  name?: string;
  url?: string;
  fileToken?: string;
}

export interface FeishuBitableWriteMappingInput {
  mappings: FeishuBitableFieldMapping[];
  texts?: string[];
  media?: FeishuBitableWriteMedia[];
  status?: string;
  error?: string;
  metadata?: Record<string, any>;
  rowData?: Record<string, any>;
  allowLocalAttachmentPlaceholders?: boolean;
}

export interface FeishuBitableWriteRecordDraft {
  recordId?: string;
  fields: Record<string, any>;
}

export interface CreateFeishuBitableWriteRecordsInput extends FeishuBitableWriteMappingInput {
  rows?: FeishuBitableNormalizedRecord[];
  mode?: 'create' | 'update';
  recordId?: string;
}

const FIELD_TYPE_LABEL: Record<number, string> = {
  1: 'text',
  2: 'number',
  3: 'singleSelect',
  4: 'multiSelect',
  5: 'date',
  7: 'checkbox',
  11: 'user',
  13: 'phone',
  15: 'url',
  17: 'attachment',
  18: 'link',
  20: 'formula',
  21: 'duplexLink',
  22: 'location',
  23: 'groupChat',
  1001: 'createdTime',
  1002: 'modifiedTime',
  1003: 'createdBy',
  1004: 'modifiedBy',
};

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)(\?|$)/i;
const VIDEO_RE = /\.(mp4|webm|mov|m4v|mkv|avi)(\?|$)/i;
const AUDIO_RE = /\.(mp3|wav|ogg|m4a|flac|aac)(\?|$)/i;

function cleanText(value: unknown, limit = 200000): string {
  return String(value ?? '').trim().slice(0, limit);
}

function firstParam(params: URLSearchParams[], keys: string[]): string | undefined {
  for (const p of params) {
    for (const key of keys) {
      const value = p.get(key);
      if (value && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function paramsFromHash(hash: string): URLSearchParams | null {
  const index = hash.indexOf('?');
  if (index < 0) return null;
  return new URLSearchParams(hash.slice(index + 1));
}

function tokenFromPlainText(raw: string): FeishuBitableParsedLink {
  const params = new URLSearchParams(raw);
  const parsed: FeishuBitableParsedLink = {};
  parsed.appToken = firstParam([params], ['app_token', 'appToken', 'base_token', 'baseToken']);
  parsed.tableId = firstParam([params], ['table', 'table_id', 'tableId']);
  parsed.viewId = firstParam([params], ['view', 'view_id', 'viewId']);
  if (parsed.appToken || parsed.tableId || parsed.viewId) return parsed;
  if (/^(?:bas|app)[A-Za-z0-9_-]{6,}$/.test(raw)) return { appToken: raw };
  return {};
}

export function parseFeishuBitableLink(value: unknown): FeishuBitableParsedLink {
  const raw = cleanText(value, 4000);
  if (!raw) return {};

  if (!/^https?:\/\//i.test(raw)) return tokenFromPlainText(raw);

  try {
    const url = new URL(raw);
    const params = [url.searchParams];
    const hashParams = paramsFromHash(url.hash);
    if (hashParams) params.push(hashParams);

    const segments = url.pathname.split('/').map((x) => decodeURIComponent(x)).filter(Boolean);
    let appToken = firstParam(params, ['app_token', 'appToken', 'base_token', 'baseToken']);
    const baseIndex = segments.findIndex((x) => x === 'base');
    if (!appToken && baseIndex >= 0 && segments[baseIndex + 1]) {
      appToken = segments[baseIndex + 1];
    }
    if (!appToken) {
      appToken = segments.find((x) => /^(?:bas|app)[A-Za-z0-9_-]{6,}$/.test(x));
    }

    return {
      appToken,
      tableId: firstParam(params, ['table', 'table_id', 'tableId']),
      viewId: firstParam(params, ['view', 'view_id', 'viewId']),
      host: url.hostname,
    };
  } catch {
    return tokenFromPlainText(raw);
  }
}

export function resolveFeishuBitableLocation(input: {
  link?: unknown;
  appToken?: unknown;
  tableId?: unknown;
  viewId?: unknown;
}): Required<Pick<FeishuBitableParsedLink, 'appToken' | 'tableId' | 'viewId'>> {
  const parsed = parseFeishuBitableLink(input.link);
  return {
    appToken: cleanText(input.appToken, 240) || parsed.appToken || '',
    tableId: cleanText(input.tableId, 240) || parsed.tableId || '',
    viewId: cleanText(input.viewId, 240) || parsed.viewId || '',
  };
}

export function normalizeFeishuFieldType(type: unknown): string {
  if (typeof type === 'number') return FIELD_TYPE_LABEL[type] || `type${type}`;
  const raw = cleanText(type, 80);
  if (!raw) return 'unknown';
  const lower = raw.toLowerCase();
  if (lower.includes('attach') || lower.includes('file') || lower.includes('附件')) return 'attachment';
  if (lower.includes('multi') && lower.includes('select')) return 'multiSelect';
  if (lower.includes('single') && lower.includes('select')) return 'singleSelect';
  if (lower.includes('number')) return 'number';
  if (lower.includes('checkbox') || lower.includes('bool')) return 'checkbox';
  if (lower.includes('date') || lower.includes('time')) return 'date';
  if (lower.includes('url') || lower.includes('link')) return 'url';
  if (lower.includes('text') || lower.includes('string')) return 'text';
  return raw;
}

export function normalizeFeishuFields(fields: unknown[]): FeishuBitableFieldInfo[] {
  return (Array.isArray(fields) ? fields : [])
    .map((field: any): FeishuBitableFieldInfo | null => {
      const name = cleanText(field?.field_name ?? field?.name ?? field?.fieldName, 240);
      const id = cleanText(field?.field_id ?? field?.id ?? field?.fieldId ?? name, 240);
      if (!name || !id) return null;
      const rawType = field?.type ?? field?.field_type ?? field?.fieldType;
      const info: FeishuBitableFieldInfo = {
        id,
        name,
        type: normalizeFeishuFieldType(rawType),
        isPrimary: Boolean(field?.is_primary ?? field?.isPrimary),
      };
      if (rawType !== undefined) info.rawType = rawType;
      if (field?.property && typeof field.property === 'object') info.property = field.property;
      return info;
    })
    .filter((field): field is FeishuBitableFieldInfo => Boolean(field));
}

function richTextToText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return cleanText(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') return String(item);
        if (item && typeof item === 'object') {
          return cleanText((item as any).text ?? (item as any).name ?? (item as any).link ?? (item as any).value);
        }
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  if (value && typeof value === 'object') {
    return cleanText((value as any).text ?? (value as any).name ?? (value as any).link ?? (value as any).value);
  }
  return '';
}

function classifyMedia(name = '', mimeType = '', url = ''): FeishuBitableMediaKind {
  const probe = `${mimeType} ${name} ${url}`;
  if (/image\//i.test(mimeType) || IMAGE_RE.test(probe)) return 'image';
  if (/video\//i.test(mimeType) || VIDEO_RE.test(probe)) return 'video';
  if (/audio\//i.test(mimeType) || AUDIO_RE.test(probe)) return 'audio';
  return 'file';
}

function attachmentFromValue(value: any, fieldName: string): FeishuBitableMedia | null {
  if (!value || typeof value !== 'object') return null;
  const fileToken = cleanText(value.file_token ?? value.fileToken ?? value.token, 500);
  const url = cleanText(value.url ?? value.tmp_url ?? value.tmpUrl ?? value.download_url ?? value.downloadUrl, 4000);
  const fallbackName = fileToken || url.split('/').pop() || 'attachment';
  const name = cleanText(value.name ?? value.file_name ?? value.fileName ?? fallbackName, 260);
  const mimeType = cleanText(value.mime_type ?? value.mimeType ?? value.type ?? value.content_type, 120);
  if (!fileToken && !url && !name) return null;
  return {
    kind: classifyMedia(name, mimeType, url),
    name,
    fileToken: fileToken || undefined,
    url: url || undefined,
    size: Number.isFinite(Number(value.size)) ? Number(value.size) : undefined,
    mimeType: mimeType || undefined,
    fieldName,
  };
}

function looksLikeAttachmentArray(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => item && typeof item === 'object' && (
    'file_token' in item || 'fileToken' in item || 'tmp_url' in item || 'download_url' in item
  ));
}

export function normalizeFeishuBitableRecord(input: {
  appToken?: string;
  tableId?: string;
  record: any;
  fields?: unknown[];
}): FeishuBitableNormalizedRecord {
  const rawFields = input.record?.fields && typeof input.record.fields === 'object'
    ? input.record.fields
    : {};
  const normalizedFields = normalizeFeishuFields(input.fields || []);
  const fieldTypeByName = new Map(normalizedFields.map((field) => [field.name, field.type]));
  const rowData: Record<string, any> = {};
  const texts: string[] = [];
  const attachments: FeishuBitableMedia[] = [];

  for (const [fieldName, rawValue] of Object.entries(rawFields)) {
    const type = fieldTypeByName.get(fieldName) || (looksLikeAttachmentArray(rawValue) ? 'attachment' : 'unknown');
    if (type === 'attachment' || looksLikeAttachmentArray(rawValue)) {
      const list = (Array.isArray(rawValue) ? rawValue : [rawValue])
        .map((item) => attachmentFromValue(item, fieldName))
        .filter((item): item is FeishuBitableMedia => Boolean(item));
      rowData[fieldName] = list;
      attachments.push(...list);
      continue;
    }
    const text = richTextToText(rawValue);
    rowData[fieldName] = text || rawValue;
    if (text) texts.push(text);
  }

  return {
    recordId: cleanText(input.record?.record_id ?? input.record?.recordId ?? input.record?.id, 240),
    appToken: input.appToken,
    tableId: input.tableId,
    fields: rawFields,
    rowData,
    texts,
    media: attachments.filter((item) => item.kind !== 'file'),
    attachments,
  };
}

function normalizeFeishuRowCandidate(value: any, fallback?: Partial<FeishuBitableNormalizedRecord>): FeishuBitableNormalizedRecord | null {
  if (!value || typeof value !== 'object') return null;
  const recordId = cleanText(value.recordId ?? value.record_id ?? value.id, 240);
  const rowData = value.rowData && typeof value.rowData === 'object' ? value.rowData : {};
  const fields = value.fields && typeof value.fields === 'object' ? value.fields : rowData;
  const texts = Array.isArray(value.texts)
    ? value.texts.map((item: unknown) => cleanText(item)).filter(Boolean)
    : [];
  const media = Array.isArray(value.media) ? value.media : [];
  const attachments = Array.isArray(value.attachments) ? value.attachments : media;
  if (!recordId && Object.keys(rowData).length === 0 && texts.length === 0 && media.length === 0) return null;
  return {
    recordId,
    appToken: cleanText(value.appToken ?? value.app_token ?? fallback?.appToken, 240) || undefined,
    tableId: cleanText(value.tableId ?? value.table_id ?? fallback?.tableId, 240) || undefined,
    fields,
    rowData,
    texts,
    media,
    attachments,
  };
}

function rowsFromUnknown(value: any, fallback?: Partial<FeishuBitableNormalizedRecord>): FeishuBitableNormalizedRecord[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((item) => normalizeFeishuRowCandidate(item, fallback))
    .filter((item): item is FeishuBitableNormalizedRecord => Boolean(item));
}

export function collectFeishuBitableRowsFromNodeData(
  data: any,
  fallback: Partial<FeishuBitableNormalizedRecord> = {},
): FeishuBitableNormalizedRecord[] {
  const d = data && typeof data === 'object' ? data : {};
  const appToken = cleanText(d.feishuAppToken ?? d.feishuOutputAppToken ?? fallback.appToken, 240) || fallback.appToken;
  const tableId = cleanText(d.feishuTableId ?? d.feishuOutputTableId ?? fallback.tableId, 240) || fallback.tableId;
  const baseFallback = { ...fallback, appToken, tableId };
  const sources = [
    d.feishuBitableRows,
    d.feishuRows,
    d.metadata?.feishuBitable?.rows,
    d.metadata?.feishuRows,
  ];
  const out: FeishuBitableNormalizedRecord[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const row of rowsFromUnknown(source, baseFallback)) {
      const key = `${row.appToken || ''}:${row.tableId || ''}:${row.recordId || JSON.stringify(row.rowData)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  const singleRecordId = cleanText(d.feishuRecordId ?? d.feishuOutputRecordId, 240);
  if (singleRecordId && !seen.has(`${appToken || ''}:${tableId || ''}:${singleRecordId}`)) {
    out.push({
      recordId: singleRecordId,
      appToken,
      tableId,
      fields: {},
      rowData: {},
      texts: [],
      media: [],
      attachments: [],
    });
  }
  return out;
}

function mediaForSource(source: FeishuBitableMappingSource, media: FeishuBitableWriteMedia[] = []): FeishuBitableWriteMedia[] {
  if (source === 'images') return media.filter((item) => item.kind === 'image');
  if (source === 'videos') return media.filter((item) => item.kind === 'video');
  if (source === 'audios') return media.filter((item) => item.kind === 'audio');
  if (source === 'allMedia') return media;
  return [];
}

function stringForMapping(mapping: FeishuBitableFieldMapping, input: FeishuBitableWriteMappingInput): string {
  if (mapping.source === 'firstText') return cleanText(input.texts?.[0] || '');
  if (mapping.source === 'allText') return (input.texts || []).map((x) => cleanText(x)).filter(Boolean).join('\n');
  if (mapping.source === 'status') return cleanText(input.status || '');
  if (mapping.source === 'error') return cleanText(input.error || '');
  if (mapping.source === 'metadataJson') return JSON.stringify(input.metadata || {}, null, 2);
  if (mapping.source === 'rowDataJson') return JSON.stringify(input.rowData || {}, null, 2);
  if (mapping.source === 'static') return cleanText(mapping.staticValue || '');
  return mediaForSource(mapping.source, input.media).map((item) => item.url || item.name || item.fileToken || '').filter(Boolean).join('\n');
}

function formatAttachmentValue(items: FeishuBitableWriteMedia[], allowLocalAttachmentPlaceholders?: boolean) {
  return items.map((item) => {
    if (item.fileToken) return { file_token: item.fileToken };
    if (allowLocalAttachmentPlaceholders && item.url) {
      return {
        name: item.name || item.url.split('/').pop() || 'attachment',
        url: item.url,
        kind: item.kind,
      };
    }
    throw new Error('飞书附件字段需要先上传为 fileToken，不能直接写入本地路径或 URL');
  });
}

function formatScalarValue(type: string, value: string) {
  if (type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (type === 'checkbox') {
    return /^(true|1|yes|y|是|勾选)$/i.test(value);
  }
  if (type === 'multiSelect') {
    return value.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
  }
  return value;
}

export function buildFeishuRecordFieldsFromMappings(input: FeishuBitableWriteMappingInput): Record<string, any> {
  const out: Record<string, any> = {};
  for (const mapping of input.mappings || []) {
    const targetField = cleanText(mapping.targetField, 240);
    if (!targetField) continue;
    const targetType = normalizeFeishuFieldType(mapping.targetType || 'text');
    if (targetType === 'attachment') {
      const items = mediaForSource(mapping.source, input.media);
      out[targetField] = formatAttachmentValue(items, input.allowLocalAttachmentPlaceholders);
      continue;
    }
    const text = stringForMapping(mapping, input);
    out[targetField] = formatScalarValue(targetType, text);
  }
  return out;
}

function mappingUsesText(mapping: FeishuBitableFieldMapping): boolean {
  return mapping.source === 'firstText' || mapping.source === 'allText';
}

function mappingUsesMedia(mapping: FeishuBitableFieldMapping): boolean {
  return mapping.source === 'images' || mapping.source === 'videos' || mapping.source === 'audios' || mapping.source === 'allMedia';
}

export function createFeishuBitableWriteRecords(input: CreateFeishuBitableWriteRecordsInput): FeishuBitableWriteRecordDraft[] {
  const rows = Array.isArray(input.rows) ? input.rows.filter(Boolean) : [];
  const mappings = input.mappings || [];
  const texts = input.texts || [];
  const media = input.media || [];
  const manualRecordId = cleanText(input.recordId, 240);
  const mode = input.mode || 'create';

  if (mode !== 'update' || manualRecordId || rows.length === 0) {
    return [{
      recordId: manualRecordId || undefined,
      fields: buildFeishuRecordFieldsFromMappings(input),
    }];
  }

  const needsTextPairing = mappings.some(mappingUsesText) && texts.length > 0;
  const needsMediaPairing = mappings.some(mappingUsesMedia) && media.length > 0;
  if (rows.length > 1) {
    if (needsTextPairing && texts.length !== rows.length) {
      throw new Error('飞书多行更新需要文本结果数量与记录数量一一对应');
    }
    if (needsMediaPairing && media.length !== rows.length) {
      throw new Error('飞书多行更新需要媒体结果数量与记录数量一一对应');
    }
  }

  return rows.map((row, index) => {
    const scopedTexts = rows.length > 1 && texts.length === rows.length ? [texts[index]] : texts;
    const scopedMedia = rows.length > 1 && media.length === rows.length ? [media[index]] : media;
    return {
      recordId: row.recordId,
      fields: buildFeishuRecordFieldsFromMappings({
        ...input,
        texts: scopedTexts,
        media: scopedMedia,
        metadata: {
          ...(input.metadata || {}),
          feishuBitable: {
            appToken: row.appToken,
            tableId: row.tableId,
            recordId: row.recordId,
          },
        },
        rowData: row.rowData,
      }),
    };
  });
}

function maskOneSecret(value: unknown): string {
  const raw = cleanText(value, 240);
  if (!raw) return '';
  const underscore = raw.indexOf('_');
  const prefix = underscore >= 0 ? raw.slice(0, underscore + 1) : raw.slice(0, Math.min(4, raw.length));
  const tail = raw.length > 4 ? raw.slice(-4) : '';
  return `${prefix}****${tail}`;
}

export function maskFeishuCredential(value: { appId?: unknown; appSecret?: unknown }) {
  const appId = cleanText(value.appId, 240);
  const appSecret = cleanText(value.appSecret, 240);
  return {
    appId: maskOneSecret(appId),
    appSecret: maskOneSecret(appSecret),
    hasAppId: Boolean(appId),
    hasAppSecret: Boolean(appSecret),
  };
}

export function assertFeishuOpenApiBase(rawValue?: unknown): string {
  const raw = cleanText(rawValue || FEISHU_OPEN_API_CN, 4000);
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.port || (host !== 'open.feishu.cn' && host !== 'open.larksuite.com')) {
    throw new Error('飞书多维表格只允许连接官方 Feishu/Lark OpenAPI');
  }
  return host === 'open.larksuite.com' ? FEISHU_OPEN_API_GLOBAL : FEISHU_OPEN_API_CN;
}
