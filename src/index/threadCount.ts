import * as os from 'os';

export function getLogicalCpuCount(): number {
  const count = os.cpus().length;
  return count > 0 ? count : 1;
}

export function resolveIndexThreadCount(setting: number): number {
  const cpuCount = getLogicalCpuCount();
  if (setting === 0) {
    return cpuCount;
  }
  return Math.max(1, Math.min(setting, cpuCount));
}
