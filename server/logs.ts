import fs from 'fs';
import path from 'path';
import { ExecutionLog } from '../src/types';
import { state, LOG_FILE_PATH, MAX_LOG_ENTRIES, MAX_LOG_FILE_BYTES } from './state';

export function estimateLogEntryBytes(entry: ExecutionLog): number {
  let bytes = 200;
  const add = (s?: string) => { if (s) bytes += s.length; };
  add(entry.id); add(entry.timestamp); add(entry.appId); add(entry.appName);
  add(entry.routeId); add(entry.routeName); add(entry.method); add(entry.url);
  add(entry.path); add(entry.clientIp); add(entry.errorMessage); add(entry.errorStack);
  for (const l of entry.logs || []) bytes += l.length;
  return bytes;
}

export function trimLogsToBudget() {
  while (state.executionLogs.length > MAX_LOG_ENTRIES || state.retainedLogBytes > MAX_LOG_FILE_BYTES) {
    const evicted = state.executionLogs.pop();
    if (!evicted) break;
    state.retainedLogBytes -= estimateLogEntryBytes(evicted);
  }
}

export function persistLogsToDisk() {
  try {
    const dir = path.dirname(LOG_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    let json = JSON.stringify(state.executionLogs);
    while (state.executionLogs.length > 0 && Buffer.byteLength(json, 'utf-8') > MAX_LOG_FILE_BYTES) {
      state.executionLogs.pop();
      json = JSON.stringify(state.executionLogs);
    }
    const tmpPath = LOG_FILE_PATH + '.tmp';
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, LOG_FILE_PATH);
  } catch (err) {
    console.error('[Log Persistence] Error saving log history:', err);
  }
}

export function scheduleLogPersist() {
  if (state.logPersistTimer) clearTimeout(state.logPersistTimer);
  state.logPersistTimer = setTimeout(() => {
    state.logPersistTimer = null;
    persistLogsToDisk();
  }, 1000);
}

export function loadLogsFromDisk() {
  try {
    if (fs.existsSync(LOG_FILE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(LOG_FILE_PATH, 'utf-8'));
      state.executionLogs = Array.isArray(parsed) ? parsed.slice(0, MAX_LOG_ENTRIES) : [];
    }
  } catch (err) {
    console.error('[Log Persistence] Error loading log history, starting fresh:', err);
    state.executionLogs = [];
  }
  state.retainedLogBytes = state.executionLogs.reduce((sum, e) => sum + estimateLogEntryBytes(e), 0);
  trimLogsToBudget();
}

export function pushExecutionLog(entry: ExecutionLog) {
  state.executionLogs.unshift(entry);
  state.retainedLogBytes += estimateLogEntryBytes(entry);
  trimLogsToBudget();
  scheduleLogPersist();
}
