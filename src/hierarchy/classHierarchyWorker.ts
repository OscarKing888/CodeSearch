import { isMainThread, parentPort } from 'worker_threads';
import { ClassDeclaration, extractClassDeclarations } from './classHierarchy';

export interface ClassHierarchyWorkerFileInput {
  path: string;
  mtime: number;
  size: number;
  content: string;
}

interface ClassHierarchyWorkerFileIdentity {
  path: string;
  mtime: number;
  size: number;
}

export interface ClassHierarchyWorkerFileSuccess extends ClassHierarchyWorkerFileIdentity {
  ok: true;
  declarations: ClassDeclaration[];
}

export interface ClassHierarchyWorkerFileFailure extends ClassHierarchyWorkerFileIdentity {
  ok: false;
  error: string;
}

export type ClassHierarchyWorkerFileResult =
  | ClassHierarchyWorkerFileSuccess
  | ClassHierarchyWorkerFileFailure;

export interface ClassHierarchyWorkerParseRequest {
  type: 'parse';
  requestId: number;
  files: ClassHierarchyWorkerFileInput[];
}

export interface ClassHierarchyWorkerReadyMessage {
  type: 'ready';
}

export interface ClassHierarchyWorkerParseResponse {
  type: 'result';
  requestId: number;
  files: ClassHierarchyWorkerFileResult[];
}

export interface ClassHierarchyWorkerErrorResponse {
  type: 'error';
  requestId?: number;
  error: string;
}

export type ClassHierarchyWorkerResponse =
  | ClassHierarchyWorkerReadyMessage
  | ClassHierarchyWorkerParseResponse
  | ClassHierarchyWorkerErrorResponse;

/** Pure batch handler shared by the worker entry point and protocol unit tests. */
export function parseClassHierarchyFiles(
  files: readonly ClassHierarchyWorkerFileInput[]
): ClassHierarchyWorkerFileResult[] {
  return files.map((file) => {
    const identity: ClassHierarchyWorkerFileIdentity = {
      path: file.path,
      mtime: file.mtime,
      size: file.size,
    };
    try {
      return {
        ...identity,
        ok: true,
        declarations: extractClassDeclarations(file.content, file.path),
      };
    } catch (error) {
      return {
        ...identity,
        ok: false,
        error: errorMessage(error),
      };
    }
  });
}

export function isClassHierarchyWorkerParseRequest(
  value: unknown
): value is ClassHierarchyWorkerParseRequest {
  if (!isRecord(value) || value.type !== 'parse' || !isPositiveInteger(value.requestId)) {
    return false;
  }
  return Array.isArray(value.files) && value.files.every(isWorkerFileInput);
}

export function isClassHierarchyWorkerResponse(
  value: unknown
): value is ClassHierarchyWorkerResponse {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'ready') {
    return true;
  }
  if (value.type === 'error') {
    return (
      typeof value.error === 'string' &&
      (value.requestId === undefined || isPositiveInteger(value.requestId))
    );
  }
  if (value.type !== 'result' || !isPositiveInteger(value.requestId) || !Array.isArray(value.files)) {
    return false;
  }
  return value.files.every(isWorkerFileResult);
}

function isWorkerFileInput(value: unknown): value is ClassHierarchyWorkerFileInput {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.mtime === 'number' &&
    Number.isFinite(value.mtime) &&
    typeof value.size === 'number' &&
    Number.isFinite(value.size) &&
    typeof value.content === 'string'
  );
}

function isWorkerFileResult(value: unknown): value is ClassHierarchyWorkerFileResult {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    typeof value.mtime !== 'number' ||
    !Number.isFinite(value.mtime) ||
    typeof value.size !== 'number' ||
    !Number.isFinite(value.size) ||
    typeof value.ok !== 'boolean'
  ) {
    return false;
  }
  return value.ok
    ? Array.isArray(value.declarations)
    : typeof value.error === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  port.postMessage({ type: 'ready' } satisfies ClassHierarchyWorkerReadyMessage);
  port.on('message', (message: unknown) => {
    if (!isClassHierarchyWorkerParseRequest(message)) {
      const requestId = isRecord(message) && isPositiveInteger(message.requestId)
        ? message.requestId
        : undefined;
      port.postMessage({
        type: 'error',
        requestId,
        error: 'Invalid class hierarchy worker request.',
      } satisfies ClassHierarchyWorkerErrorResponse);
      return;
    }

    try {
      port.postMessage({
        type: 'result',
        requestId: message.requestId,
        files: parseClassHierarchyFiles(message.files),
      } satisfies ClassHierarchyWorkerParseResponse);
    } catch (error) {
      port.postMessage({
        type: 'error',
        requestId: message.requestId,
        error: errorMessage(error),
      } satisfies ClassHierarchyWorkerErrorResponse);
    }
  });
}
