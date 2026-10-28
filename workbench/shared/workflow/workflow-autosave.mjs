export const WORKFLOW_AUTOSAVE_DEFAULTS = Object.freeze({ enabled: true, intervalMinutes: 10 });

function ownData(preferences, key) {
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) return undefined;
  try {
    const field = Object.getOwnPropertyDescriptor(preferences, key);
    return field && Object.hasOwn(field, 'value') ? field.value : undefined;
  } catch { return undefined; }
}

export function workflowAutosavePolicy(preferences) {
  const enabledValue = ownData(preferences, 'workflowAutosaveEnabled');
  const intervalValue = ownData(preferences, 'workflowAutosaveIntervalMinutes');
  const enabled = typeof enabledValue === 'boolean' ? enabledValue : WORKFLOW_AUTOSAVE_DEFAULTS.enabled;
  const intervalMinutes = Number.isInteger(intervalValue) && intervalValue >= 1 && intervalValue <= 1440
    ? intervalValue : WORKFLOW_AUTOSAVE_DEFAULTS.intervalMinutes;
  return { enabled, intervalMinutes, intervalMs: intervalMinutes * 60_000 };
}
