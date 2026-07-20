import type { RunContext, RunNodeLifecycleEventType, RunNodeLifecycleReporter } from '../types/project';

export type RunExecutionDisposition = 'active' | 'stopped' | 'superseded' | 'released';

export function resolveRunExecutionDisposition(
  currentExecutionToken: string | null | undefined,
  executionToken: string,
  cancelled: boolean,
): RunExecutionDisposition {
  if (cancelled) return 'stopped';
  if (currentExecutionToken === executionToken) return 'active';
  if (currentExecutionToken) return 'superseded';
  return 'released';
}

export interface RunNodeLifecycleSink {
  write(type: RunNodeLifecycleEventType, payload: Record<string, unknown>): Promise<void>;
}

export interface RunNodeLifecycleController {
  reporter: RunNodeLifecycleReporter;
  outputEmitted(): boolean;
  flush(): Promise<void>;
}

/**
 * Serializes lifecycle writes so a provider may report progress without
 * awaiting every call while terminal persistence can still wait for all
 * earlier events. The sink owns redaction and durable storage.
 */
export function createRunNodeLifecycleController(input: {
  runContext: RunContext | null;
  executionToken: string;
  basePayload?: Record<string, unknown>;
  sink: RunNodeLifecycleSink;
}): RunNodeLifecycleController {
  let queue = Promise.resolve();
  let didEmitOutput = false;
  let sequence = 0;

  const write = (type: RunNodeLifecycleEventType, payload: Record<string, unknown> = {}) => {
    if (type === 'node.output') didEmitOutput = true;
    sequence += 1;
    const eventPayload = {
      ...(input.basePayload || {}),
      ...payload,
      executionToken: input.executionToken,
      sequence,
    };
    const operation = queue.then(() => input.sink.write(type, eventPayload));
    queue = operation.catch(() => undefined);
    return operation;
  };

  return {
    reporter: {
      runContext: input.runContext,
      executionToken: input.executionToken,
      progress: (payload = {}) => write('node.progress', payload),
      polling: (payload = {}) => write('node.polling', payload),
      output: (payload = {}) => write('node.output', payload),
      providerRequest: (payload = {}) => write('provider.request', payload),
      providerSubmitted: (payload = {}) => write('provider.submitted', payload),
      providerPolling: (payload = {}) => write('provider.polling', payload),
      providerResponse: (payload = {}) => write('provider.response', payload),
      providerUsage: (payload = {}) => write('provider.usage', payload),
    },
    outputEmitted: () => didEmitOutput,
    flush: () => queue,
  };
}
