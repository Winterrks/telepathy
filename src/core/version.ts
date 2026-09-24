declare const __TELEPATHY_VERSION__: string | undefined;

/** Injected by scripts/build.mjs from package.json. */
export const VERSION: string =
  typeof __TELEPATHY_VERSION__ === 'string' ? __TELEPATHY_VERSION__ : '0.0.0-dev';
