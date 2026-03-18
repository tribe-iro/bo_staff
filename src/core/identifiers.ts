const SAFE_OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeOpaqueId(value: string): boolean {
  return SAFE_OPAQUE_ID_PATTERN.test(value)
    && !value.includes("..");
}

export function isSafeSessionHandle(value: string): boolean {
  return isSafeOpaqueId(value);
}

export function isSafeExecutionId(value: string): boolean {
  return isSafeOpaqueId(value);
}
