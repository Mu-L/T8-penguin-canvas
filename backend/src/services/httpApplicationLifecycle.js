'use strict';

function createHttpApplicationLifecycle() {
  const requestLifecycle = Symbol('t8-http-application-lifecycle');
  const activeRequests = new Set();
  const activeStandaloneTasks = new Set();
  const drainWaiters = new Set();
  const wrappedHandlers = new WeakMap();
  const wrappedRouters = new WeakSet();
  const installedApps = new WeakSet();

  function status() {
    let pendingHandlers = 0;
    for (const state of activeRequests) pendingHandlers += state.pendingHandlers;
    return {
      activeRequests: activeRequests.size,
      pendingHandlers,
      pendingTasks: activeStandaloneTasks.size,
    };
  }

  function drained() {
    return activeRequests.size === 0 && activeStandaloneTasks.size === 0;
  }

  function resolveDrainWaiters() {
    if (!drained()) return;
    for (const waiter of drainWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ drained: true, ...status() });
    }
    drainWaiters.clear();
  }

  function settleRequest(state) {
    if (state.settled || !state.trackingArmed || !state.responseTerminal || state.pendingHandlers !== 0) return;
    state.settled = true;
    activeRequests.delete(state);
    resolveDrainWaiters();
  }

  function acquireHandlerLease(req, res) {
    const state = req?.[requestLifecycle];
    if (!state) return null;
    if (state.settled) {
      state.settled = false;
      activeRequests.add(state);
    }
    state.pendingHandlers += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      state.responseEndWaiters.delete(release);
      res.removeListener('finish', release);
      state.pendingHandlers = Math.max(0, state.pendingHandlers - 1);
      settleRequest(state);
    };
    const waitForResponseEnd = (allowEndInvocation = true) => {
      if (state.responseFinished || res.writableFinished) {
        release();
        return;
      }
      res.once('finish', release);
      if (allowEndInvocation) {
        if (state.responseEndInvoked || res.writableEnded) {
          release();
          return;
        }
        state.responseEndWaiters.add(release);
      }
      // A socket close does not settle callback-style application work. Its
      // lease remains until next(), a normal response end, or its Promise.
    };
    return { release, waitForResponseEnd };
  }

  function trackTask(req, res, task) {
    if (!task || typeof task.then !== 'function') return task;
    const lease = acquireHandlerLease(req, res);
    if (!lease) return trackStandaloneTask(task);
    Promise.resolve(task).then(lease.release, lease.release);
    return task;
  }

  function trackStandaloneTask(task) {
    if (!task || typeof task.then !== 'function') return task;
    activeStandaloneTasks.add(task);
    const release = () => {
      activeStandaloneTasks.delete(task);
      resolveDrainWaiters();
    };
    Promise.resolve(task).then(release, release);
    return task;
  }

  function middleware(req, res, next) {
    const state = {
      pendingHandlers: 0,
      responseTerminal: false,
      responseFinished: false,
      responseEndInvoked: false,
      responseEndWaiters: new Set(),
      trackingArmed: false,
      settled: false,
    };
    req[requestLifecycle] = state;
    activeRequests.add(state);
    res.locals = res.locals || {};
    res.locals.trackApplicationTask = (task) => trackTask(req, res, task);
    const originalEnd = res.end;
    res.end = function trackedResponseEnd(...args) {
      state.responseEndInvoked = true;
      try {
        return originalEnd.apply(this, args);
      } finally {
        for (const release of state.responseEndWaiters) release();
        state.responseEndWaiters.clear();
      }
    };
    const markResponseTerminal = () => {
      state.responseTerminal = true;
      settleRequest(state);
    };
    res.once('finish', () => {
      state.responseFinished = true;
      markResponseTerminal();
    });
    res.once('close', markResponseTerminal);
    queueMicrotask(() => {
      state.trackingArmed = true;
      settleRequest(state);
    });
    next();
  }

  function invokeHandler(handler, receiver, error, req, res, next) {
    const lease = acquireHandlerLease(req, res);
    if (!lease) {
      return error === undefined
        ? handler.call(receiver, req, res, next)
        : handler.call(receiver, error, req, res, next);
    }
    let invocationReturned = false;
    let returnedPromise = false;
    let nextCalled = false;
    const trackedNext = (...args) => {
      nextCalled = true;
      try {
        return next(...args);
      } finally {
        if (invocationReturned && !returnedPromise) lease.release();
      }
    };
    let result;
    try {
      result = error === undefined
        ? handler.call(receiver, req, res, trackedNext)
        : handler.call(receiver, error, req, res, trackedNext);
    } catch (caught) {
      invocationReturned = true;
      try {
        return trackedNext(caught);
      } finally {
        lease.release();
      }
    }
    invocationReturned = true;
    returnedPromise = Boolean(result && typeof result.then === 'function');
    if (returnedPromise) {
      Promise.resolve(result).then(
        () => lease.release(),
        (caught) => {
          try {
            trackedNext(caught);
          } finally {
            lease.release();
          }
        },
      );
    } else if (nextCalled) {
      lease.release();
    } else {
      lease.waitForResponseEnd();
    }
    return result;
  }

  function wrapHandler(handler) {
    if (typeof handler !== 'function') return handler;
    if (handler.stack && Array.isArray(handler.stack)) {
      wrapRouter(handler);
      return handler;
    }
    const existing = wrappedHandlers.get(handler);
    if (existing) return existing;
    const wrapped = handler.length === 4
      ? function trackedErrorHandler(error, req, res, next) {
        return invokeHandler(handler, this, error, req, res, next);
      }
      : function trackedRequestHandler(req, res, next) {
        return invokeHandler(handler, this, undefined, req, res, next);
      };
    wrappedHandlers.set(handler, wrapped);
    wrappedHandlers.set(wrapped, wrapped);
    return wrapped;
  }

  function wrapLayer(layer) {
    if (!layer || typeof layer !== 'object') return;
    if (layer.route?.stack && Array.isArray(layer.route.stack)) {
      layer.route.stack.forEach(wrapLayer);
      return;
    }
    if (layer.handle?.stack && Array.isArray(layer.handle.stack)) {
      wrapRouter(layer.handle);
      return;
    }
    if (typeof layer.handle === 'function') layer.handle = wrapHandler(layer.handle);
  }

  function wrapRouter(router) {
    if (!router || wrappedRouters.has(router)) return router;
    wrappedRouters.add(router);
    if (Array.isArray(router.stack)) router.stack.forEach(wrapLayer);
    return router;
  }

  function wrapRegistrationArgument(value) {
    if (Array.isArray(value)) return value.map(wrapRegistrationArgument);
    if (typeof value === 'function') return wrapHandler(value);
    return value;
  }

  function install(app) {
    if (!app || installedApps.has(app)) return app;
    installedApps.add(app);
    app.use(middleware);
    for (const method of ['use', 'all', 'get', 'post', 'put', 'patch', 'delete', 'options', 'head']) {
      const register = app[method].bind(app);
      app[method] = (...args) => register(...args.map(wrapRegistrationArgument));
    }
    return app;
  }

  function waitForDrain(timeoutMs = null) {
    if (drained()) return Promise.resolve({ drained: true, ...status() });
    const hasTimeout = timeoutMs !== null && timeoutMs !== undefined;
    const requestedTimeout = hasTimeout ? Number(timeoutMs) : Number.NaN;
    if (hasTimeout && Number.isFinite(requestedTimeout) && requestedTimeout <= 0) {
      return Promise.resolve({ drained: false, ...status() });
    }
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      if (hasTimeout && Number.isFinite(requestedTimeout)) {
        waiter.timer = setTimeout(() => {
          drainWaiters.delete(waiter);
          resolve({ drained: false, ...status() });
        }, requestedTimeout);
      }
      drainWaiters.add(waiter);
    });
  }

  return {
    install,
    status,
    waitForDrain,
    trackStandaloneTask,
  };
}

module.exports = { createHttpApplicationLifecycle };
