import {
  RENDERER_APPEARANCE_ARGUMENT,
  RENDERER_SERVER_ORIGIN_ARGUMENT,
  type RendererRuntimeConfig,
  rendererRuntimeConfigSchema,
} from '../../shared/protocols/electron/runtime.ts';

export type RuntimeConfig = Readonly<RendererRuntimeConfig>;

export function createRuntimeConfig(argv: readonly string[]): RuntimeConfig {
  const argument = argv.find((value) => value.startsWith(RENDERER_SERVER_ORIGIN_ARGUMENT));
  const serverOrigin = argument?.slice(RENDERER_SERVER_ORIGIN_ARGUMENT.length);
  return Object.freeze(
    rendererRuntimeConfigSchema.parse({ serverOrigin, ...firstPaintAppearance(argv) }),
  );
}

/** The appearance main remembered, if it is one this build can read. An
 *  unreadable copy only costs the first paint, so it is dropped, not fatal. */
function firstPaintAppearance(argv: readonly string[]) {
  const argument = argv.find((value) => value.startsWith(RENDERER_APPEARANCE_ARGUMENT));
  if (!argument) return {};
  try {
    const parsed = rendererRuntimeConfigSchema.shape.appearance.safeParse(
      JSON.parse(argument.slice(RENDERER_APPEARANCE_ARGUMENT.length)),
    );
    return parsed.success && parsed.data ? { appearance: parsed.data } : {};
  } catch {
    return {};
  }
}
