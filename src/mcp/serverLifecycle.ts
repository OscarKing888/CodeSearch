export interface McpServerLifecycleTarget {
  oninitialized?: () => void;
  sendToolListChanged(): Promise<void>;
}

/**
 * Some Cursor shared-process builds can persist the initial connected snapshot
 * before requesting tools/list, leaving a healthy stdio server stuck at zero
 * tools. Re-advertise the already registered list after the MCP initialized
 * notification so the client refreshes its durable snapshot.
 */
export function installPostInitializeToolRefresh(
  target: McpServerLifecycleTarget,
  log: (message: string) => void
): void {
  const previous = target.oninitialized;
  target.oninitialized = () => {
    try {
      previous?.();
    } finally {
      void target.sendToolListChanged().catch((error) => {
        log(
          `Could not refresh the MCP tool list after initialization: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    }
  };
}
