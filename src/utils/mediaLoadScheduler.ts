export type MediaLoadKind = 'image' | 'video' | 'audio';

export const MEDIA_VISIBILITY_ROOT_MARGIN = '0px';
export const MEDIA_LOAD_CONCURRENCY: Readonly<Record<MediaLoadKind, number>> = {
  image: 4,
  video: 1,
  audio: 1,
};
const MEDIA_LOAD_SLOT_TIMEOUT_MS = 30_000;

export interface MediaLoadQueueHandle {
  cancel(): void;
}

export interface MediaLoadQueue {
  schedule(start: (release: () => void) => void, priority?: boolean): MediaLoadQueueHandle;
  readonly activeCount: number;
  readonly queuedCount: number;
}

interface QueuedMediaLoad {
  cancelled: boolean;
  activeRelease: (() => void) | null;
  start: (release: () => void) => void;
}

export function createMediaLoadQueue(maxConcurrent: number): MediaLoadQueue {
  const concurrency = Math.max(1, Math.trunc(maxConcurrent) || 1);
  const pending: QueuedMediaLoad[] = [];
  let activeCount = 0;

  const drain = () => {
    while (activeCount < concurrency && pending.length > 0) {
      const task = pending.shift();
      if (!task || task.cancelled) continue;
      activeCount += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        task.activeRelease = null;
        activeCount = Math.max(0, activeCount - 1);
        drain();
      };
      task.activeRelease = release;
      try {
        task.start(release);
      } catch {
        release();
      }
    }
  };

  return {
    schedule(start, priority = false) {
      const task: QueuedMediaLoad = { cancelled: false, activeRelease: null, start };
      if (priority) pending.unshift(task);
      else pending.push(task);
      drain();
      return {
        cancel() {
          if (task.cancelled) return;
          task.cancelled = true;
          task.activeRelease?.();
          drain();
        },
      };
    },
    get activeCount() {
      return activeCount;
    },
    get queuedCount() {
      return pending.reduce((count, task) => count + (task.cancelled ? 0 : 1), 0);
    },
  };
}

export interface VisibleMediaLoadController {
  request(): void;
  cancel(): void;
}

export interface VisibleMediaLoadOptions {
  onVisibilityChange?: (isVisible: boolean) => void;
}

interface VisibilityRegistration {
  update(isVisible: boolean): void;
}

const loadQueues: Record<MediaLoadKind, MediaLoadQueue> = {
  image: createMediaLoadQueue(MEDIA_LOAD_CONCURRENCY.image),
  video: createMediaLoadQueue(MEDIA_LOAD_CONCURRENCY.video),
  audio: createMediaLoadQueue(MEDIA_LOAD_CONCURRENCY.audio),
};
const visibilityRegistrations = new Map<Element, VisibilityRegistration>();
let sharedVisibilityObserver: IntersectionObserver | null = null;

function getSharedVisibilityObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  if (!sharedVisibilityObserver) {
    sharedVisibilityObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visibilityRegistrations.get(entry.target)?.update(entry.isIntersecting);
        }
      },
      { rootMargin: MEDIA_VISIBILITY_ROOT_MARGIN, threshold: 0.01 },
    );
  }
  return sharedVisibilityObserver;
}

export function observeVisibleMediaLoad(
  element: Element,
  kind: MediaLoadKind,
  onGranted: (release: () => void) => void,
  options: VisibleMediaLoadOptions = {},
): VisibleMediaLoadController {
  const observer = getSharedVisibilityObserver();
  let visible = false;
  let forced = false;
  let granted = false;
  let disposed = false;
  let queueHandle: MediaLoadQueueHandle | null = null;
  let activeRelease: (() => void) | null = null;

  const stopObserving = () => {
    observer?.unobserve(element);
    visibilityRegistrations.delete(element);
  };

  const enqueue = (priority: boolean) => {
    if (disposed || granted || (!forced && !visible)) return;
    if (priority && queueHandle) {
      queueHandle.cancel();
      queueHandle = null;
    }
    if (queueHandle) return;
    queueHandle = loadQueues[kind].schedule((releaseSlot) => {
      queueHandle = null;
      if (disposed || (!forced && !visible)) {
        releaseSlot();
        return;
      }
      granted = true;
      if (!options.onVisibilityChange) stopObserving();
      let completed = false;
      const timeout = globalThis.setTimeout(() => {
        complete();
      }, MEDIA_LOAD_SLOT_TIMEOUT_MS);
      const complete = () => {
        if (completed) return;
        completed = true;
        globalThis.clearTimeout(timeout);
        activeRelease = null;
        releaseSlot();
      };
      activeRelease = complete;
      try {
        onGranted(complete);
      } catch {
        complete();
      }
    }, priority);
  };

  const registration: VisibilityRegistration = {
    update(isVisible) {
      visible = isVisible;
      options.onVisibilityChange?.(visible);
      if (visible) {
        enqueue(false);
      } else if (!forced && !granted && queueHandle) {
        queueHandle.cancel();
        queueHandle = null;
      }
    },
  };

  visibilityRegistrations.set(element, registration);
  if (observer) observer.observe(element);
  else {
    visible = true;
    options.onVisibilityChange?.(true);
    enqueue(false);
  }

  return {
    request() {
      forced = true;
      enqueue(true);
    },
    cancel() {
      if (disposed) return;
      disposed = true;
      stopObserving();
      queueHandle?.cancel();
      queueHandle = null;
      activeRelease?.();
      activeRelease = null;
    },
  };
}
