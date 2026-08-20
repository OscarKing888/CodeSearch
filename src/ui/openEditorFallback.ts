export type OpenFallbackReason = 'missing' | 'syncRefused' | 'unknown';

export type OpenFallbackResult =
  | { outcome: 'document' }
  | { outcome: 'command' }
  | { outcome: 'failed'; reason: OpenFallbackReason; detail: string };

export interface OpenFallbackDeps {
  openViaDocument(): Promise<void>;
  openViaCommand(): Promise<void>;
  fileExists(): boolean | Promise<boolean>;
}

export function isExtensionSyncRefusalError(error: unknown): boolean {
  return /synchronized with extensions/i.test(errorDetail(error));
}

export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function openWithFallback(deps: OpenFallbackDeps): Promise<OpenFallbackResult> {
  try {
    await deps.openViaDocument();
    return { outcome: 'document' };
  } catch (documentError) {
    try {
      await deps.openViaCommand();
      return { outcome: 'command' };
    } catch (commandError) {
      const exists = await deps.fileExists();
      if (!exists) {
        return { outcome: 'failed', reason: 'missing', detail: errorDetail(commandError) };
      }
      if (
        isExtensionSyncRefusalError(documentError) ||
        isExtensionSyncRefusalError(commandError)
      ) {
        return {
          outcome: 'failed',
          reason: 'syncRefused',
          detail: errorDetail(commandError),
        };
      }
      return { outcome: 'failed', reason: 'unknown', detail: errorDetail(commandError) };
    }
  }
}

export function formatOpenEditorFailureMessage(
  filePath: string,
  result: Extract<OpenFallbackResult, { outcome: 'failed' }>
): string {
  switch (result.reason) {
    case 'missing':
      return `Ace Code Search: 无法打开 ${filePath}。文件不存在，索引可能已过期，请刷新索引后再试。`;
    case 'syncRefused':
      return `Ace Code Search: 无法打开 ${filePath}。编辑器拒绝将该文档同步到扩展进程，请从资源管理器直接打开该文件。`;
    default:
      return `Ace Code Search: 无法打开 ${filePath}。${result.detail}`;
  }
}
