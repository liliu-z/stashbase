function present(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function resolveWindowsSigningConfiguration(env) {
  const configured = ['CSC_LINK', 'CSC_KEY_PASSWORD'].filter((name) => present(env[name]));
  if (configured.length === 0) return false;
  if (configured.length !== 2) {
    const missing = ['CSC_LINK', 'CSC_KEY_PASSWORD'].filter((name) => !present(env[name]));
    throw new Error(
      `Windows signing credentials are incomplete; missing ${missing.join(', ')}. ` +
        'Configure both values to sign, or remove both values to build an unsigned installer.',
    );
  }
  return true;
}
