import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../../services/api';
import type {
  AssetRef,
  AssetSemanticSearchHit,
  AssetSemanticSearchIdentity,
  AssetSemanticSearchPage,
  AssetSemanticStatus,
} from '../../types/project';
import {
  ASSET_PAGE_CACHE_LIMIT,
  ASSET_PAGE_REQUEST_LIMIT,
  ASSET_PAGE_SIZE,
  assetPageOffsetsForRange,
} from '../../utils/assetVirtualization';
import {
  assetSemanticAvailability,
  assetSemanticSearchIdentityMatches,
  buildAssetD4FilterKey,
  normalizeAssetSemanticQuery,
  readAssetSemanticPageHit,
  updateAssetSemanticPageLru,
} from './assetD4State';

function isAbortError(error: unknown): boolean {
  return (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError')
    || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
}

export interface AssetSemanticCatalogOptions {
  active: boolean;
  projectId: string;
  query: string;
  filters: Record<string, unknown>;
  status: AssetSemanticStatus | null;
  onConflict?: () => void | Promise<void>;
}

export interface AssetSemanticCatalogResult {
  availability: ReturnType<typeof assetSemanticAvailability>;
  total: number;
  loading: boolean;
  error: string;
  cacheRevision: number;
  resetKey: string;
  conflictRevision: number;
  getItem: (index: number) => AssetRef | undefined;
  getHit: (index: number) => AssetSemanticSearchHit | undefined;
  getHitByAssetId: (assetId: string) => AssetSemanticSearchHit | undefined;
  ensureRange: (startIndex: number, endIndex: number) => void;
  reset: () => void;
}

export default function useAssetSemanticCatalog(options: AssetSemanticCatalogOptions): AssetSemanticCatalogResult {
  const normalizedQuery = normalizeAssetSemanticQuery(options.query);
  const availability = assetSemanticAvailability(options.status?.project);
  const embedding = options.status?.project.capabilities.embedding;
  const resetKeyBase = buildAssetD4FilterKey({
    mode: 'semantic',
    projectId: options.projectId,
    semanticQuery: normalizedQuery,
    filters: {
      ...options.filters,
      profileRevision: options.status?.project.revision ?? '',
      currentCatalogRevision: options.status?.project.currentCatalogRevision ?? '',
    },
    semanticIdentity: options.status ? {
      semanticIndexRevision: options.status.project.activeIndexRevision,
      activeGeneration: options.status.project.activeGeneration,
      modelKey: embedding?.modelKey || '',
      modelVersion: embedding?.modelVersion || '',
    } : null,
  });
  const [refreshRevision, setRefreshRevision] = useState(0);
  const resetKey = `${resetKeyBase}:${refreshRevision}`;
  const pagesRef = useRef<Map<number, AssetSemanticSearchPage>>(new Map());
  const controllersRef = useRef(new Map<number, AbortController>());
  const visibleOffsetsRef = useRef<Set<number>>(new Set([0]));
  const requestGenerationRef = useRef(0);
  const identityRef = useRef<AssetSemanticSearchIdentity | null>(null);
  const conflictRecoveryRef = useRef(false);
  const projectIdRef = useRef(options.projectId);
  const statusRef = useRef(options.status);
  const filtersRef = useRef(options.filters);
  projectIdRef.current = options.projectId;
  statusRef.current = options.status;
  filtersRef.current = options.filters;
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cacheRevision, setCacheRevision] = useState(0);
  const [conflictRevision, setConflictRevision] = useState(0);

  const invalidate = useCallback((message = '') => {
    requestGenerationRef.current += 1;
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    pagesRef.current = new Map();
    identityRef.current = null;
    visibleOffsetsRef.current = new Set([0]);
    setTotal(0);
    setLoading(false);
    setError(message);
    setCacheRevision((value) => value + 1);
  }, []);

  const recoverConflict = useCallback(() => {
    if (conflictRecoveryRef.current) return;
    conflictRecoveryRef.current = true;
    const expectedProjectId = options.projectId;
    invalidate('素材目录、语义配置或活动索引已变化，结果与证据已清空，正在重新读取。');
    setConflictRevision((value) => value + 1);
    Promise.resolve(options.onConflict?.()).catch((caught) => {
      setError(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => {
      conflictRecoveryRef.current = false;
      if (projectIdRef.current === expectedProjectId) setRefreshRevision((value) => value + 1);
    });
  }, [invalidate, options.onConflict, options.projectId]);

  const requestPage = useCallback(async (
    offset: number,
    generation: number,
    status: AssetSemanticStatus,
    query: string,
    filters: Record<string, unknown>,
    force = false,
  ) => {
    const cached = pagesRef.current.get(offset);
    if (cached && !force) {
      pagesRef.current = updateAssetSemanticPageLru(pagesRef.current, offset, cached, ASSET_PAGE_CACHE_LIMIT);
      return;
    }
    if (!visibleOffsetsRef.current.has(offset) || controllersRef.current.has(offset)
      || controllersRef.current.size >= ASSET_PAGE_REQUEST_LIMIT) return;
    const controller = new AbortController();
    controllersRef.current.set(offset, controller);
    setLoading(true);
    const expectedIdentity = identityRef.current;
    try {
      const page = await api.searchProjectAssetsSemantic({
        projectId: options.projectId,
        query,
        filters,
        limit: ASSET_PAGE_SIZE,
        offset,
        expectedCatalogRevision: expectedIdentity?.catalogRevision ?? status.project.currentCatalogRevision,
        expectedProfileRevision: Number(status.project.revision),
        expectedGeneration: expectedIdentity?.activeGeneration ?? status.project.activeGeneration,
      }, { signal: controller.signal });
      if (controller.signal.aborted || generation !== requestGenerationRef.current
        || controllersRef.current.get(offset) !== controller || !visibleOffsetsRef.current.has(offset)) return;
      if (page.offset !== offset || !page.identity.queryDigest || page.identity.projectId !== options.projectId) {
        throw new Error('语义搜索返回了不一致的分页身份');
      }
      if (identityRef.current && !assetSemanticSearchIdentityMatches(identityRef.current, page.identity)) {
        recoverConflict();
        return;
      }
      if (!identityRef.current) identityRef.current = page.identity;
      pagesRef.current = updateAssetSemanticPageLru(pagesRef.current, offset, page, ASSET_PAGE_CACHE_LIMIT);
      setTotal(page.total);
      setError('');
      setCacheRevision((value) => value + 1);
    } catch (caught) {
      if (controller.signal.aborted || generation !== requestGenerationRef.current || isAbortError(caught)) return;
      if (caught instanceof api.ApiRequestError && caught.status === 409) recoverConflict();
      else setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (controllersRef.current.get(offset) === controller) controllersRef.current.delete(offset);
      if (generation === requestGenerationRef.current) setLoading(controllersRef.current.size > 0);
    }
  }, [options.projectId, recoverConflict]);

  useEffect(() => {
    invalidate();
    const status = statusRef.current;
    if (!options.active || !normalizedQuery || !availability.searchable || !status) return undefined;
    const generation = requestGenerationRef.current;
    visibleOffsetsRef.current = new Set([0]);
    void requestPage(0, generation, status, normalizedQuery, filtersRef.current);
    return () => {
      requestGenerationRef.current += 1;
      controllersRef.current.forEach((controller) => controller.abort());
      controllersRef.current.clear();
    };
  }, [availability.searchable, invalidate, normalizedQuery, options.active, requestPage, resetKey]);

  const ensureRange = useCallback((startIndex: number, endIndex: number) => {
    const status = statusRef.current;
    if (!options.active || !status || !normalizedQuery || !availability.searchable) return;
    const offsets = assetPageOffsetsForRange(startIndex, endIndex, ASSET_PAGE_SIZE);
    if (!offsets.length) return;
    const visibleOffsets = new Set(offsets);
    visibleOffsetsRef.current = visibleOffsets;
    controllersRef.current.forEach((controller, offset) => {
      if (visibleOffsets.has(offset)) return;
      controller.abort();
      controllersRef.current.delete(offset);
    });
    const generation = requestGenerationRef.current;
    const anchor = (Math.max(0, startIndex) + Math.max(startIndex, endIndex - 1)) / 2;
    offsets.sort((left, right) => Math.abs(left + ASSET_PAGE_SIZE / 2 - anchor) - Math.abs(right + ASSET_PAGE_SIZE / 2 - anchor));
    offsets.forEach((offset) => {
      void requestPage(offset, generation, status, normalizedQuery, filtersRef.current);
    });
  }, [availability.searchable, normalizedQuery, options.active, requestPage]);

  const getHit = useCallback((index: number) => readAssetSemanticPageHit(pagesRef.current, index, ASSET_PAGE_SIZE), [cacheRevision]);
  const getItem = useCallback((index: number) => getHit(index)?.asset, [getHit]);
  const getHitByAssetId = useCallback((assetId: string) => {
    for (const page of pagesRef.current.values()) {
      const hit = page.hits.find((entry) => entry.asset.id === assetId);
      if (hit) return hit;
    }
    return undefined;
  }, [cacheRevision]);
  const reset = useCallback(() => setRefreshRevision((value) => value + 1), []);

  return useMemo(() => ({
    availability,
    total,
    loading,
    error,
    cacheRevision,
    resetKey,
    conflictRevision,
    getItem,
    getHit,
    getHitByAssetId,
    ensureRange,
    reset,
  }), [availability, cacheRevision, conflictRevision, ensureRange, error, getHit, getHitByAssetId, getItem, loading, reset, resetKey, total]);
}
