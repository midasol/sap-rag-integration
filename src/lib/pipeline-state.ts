export interface PipelineStatus {
  running: boolean;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  currentFile: string;
  logs: Array<{ fileName: string; status: 'success' | 'error'; message?: string; duration: number }>;
}

let status: PipelineStatus = {
  running: false,
  total: 0,
  completed: 0,
  succeeded: 0,
  failed: 0,
  currentFile: '',
  logs: [],
};

export function getStatus(): PipelineStatus {
  return { ...status };
}

export function resetStatus(total: number) {
  status = { running: true, total, completed: 0, succeeded: 0, failed: 0, currentFile: '', logs: [] };
}

export function updateStatus(update: Partial<PipelineStatus>) {
  Object.assign(status, update);
}

export function addLog(log: PipelineStatus['logs'][0]) {
  status.logs.unshift(log);
  if (status.logs.length > 100) status.logs.pop();
}
