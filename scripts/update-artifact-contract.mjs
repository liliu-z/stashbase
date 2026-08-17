export function assertMacUpdateArtifacts(artifacts) {
  const names = artifacts.map((file) => String(file).split(/[\\/]/).at(-1));
  const required = [
    ['DMG installer', (name) => name.endsWith('.dmg')],
    ['ZIP update payload', (name) => name.endsWith('.zip')],
    ['latest-mac.yml metadata', (name) => name === 'latest-mac.yml'],
  ];
  const missing = required.filter(([, matches]) => !names.some(matches)).map(([label]) => label);
  if (missing.length > 0) {
    throw new Error(`macOS release is incomplete: missing ${missing.join(', ')}.`);
  }
}
