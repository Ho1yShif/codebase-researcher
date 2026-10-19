/**
 * Drops blank values before env parsing: a `sync: false` variable left empty in the Render Dashboard arrives
 * as "", which should mean "unset" (use the default), not an invalid value.
 */
export function present(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v?.trim()));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
