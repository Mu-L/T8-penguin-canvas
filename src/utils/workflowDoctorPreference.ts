export const WORKFLOW_DOCTOR_ENABLED_STORAGE_KEY = 't8-workflow-doctor-enabled';

type WorkflowDoctorPreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): WorkflowDoctorPreferenceStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.localStorage;
}

export function readWorkflowDoctorEnabled(
  storage: WorkflowDoctorPreferenceStorage | undefined = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(WORKFLOW_DOCTOR_ENABLED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeWorkflowDoctorEnabled(
  enabled: boolean,
  storage: WorkflowDoctorPreferenceStorage | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    if (enabled) storage.setItem(WORKFLOW_DOCTOR_ENABLED_STORAGE_KEY, '1');
    else storage.removeItem(WORKFLOW_DOCTOR_ENABLED_STORAGE_KEY);
  } catch {
    // Storage may be unavailable in privacy modes. The current session state still works.
  }
}
