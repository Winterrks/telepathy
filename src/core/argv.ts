/**
 * The value after `name` in `argv`. Absent, missing, or another flag (`--name --agent`) is unset.
 * `indexOf` is -1 when the flag is absent, and `argv[0]` must not be read as the value: for
 * `telepathy mcp --agent copilot` that word is `mcp`.
 */
export function argvFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}
