'use client';

import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Play, FolderOpen } from 'lucide-react';

interface PipelineStatus {
  running: boolean;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  currentFile: string;
  logs: Array<{ fileName: string; status: 'success' | 'error'; message?: string; duration: number }>;
}

export function PipelineDashboard() {
  const [sourcePath, setSourcePath] = useState('');
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  async function startPipeline() {
    await fetch('/api/pipeline/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath }),
    });
    startPolling();
  }

  async function handleFolderSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append('files', files[i]);
    }

    await fetch('/api/pipeline/upload', {
      method: 'POST',
      body: formData,
    });
    startPolling();

    // Reset input so the same folder can be selected again
    if (folderInputRef.current) folderInputRef.current.value = '';
  }

  function startPolling() {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(async () => {
      const res = await fetch('/api/pipeline/status');
      const data = await res.json();
      setStatus(data);
      if (!data.running && intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    }, 1000);
  }

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const progress = status ? (status.total > 0 ? (status.completed / status.total) * 100 : 0) : 0;
  const isRunning = status?.running ?? false;

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-bold">Batch Embedding Pipeline</h1>

      <div className="space-y-3">
        <div className="flex gap-2">
          <Input
            value={sourcePath}
            onChange={(e) => setSourcePath(e.target.value)}
            placeholder="GCS path (e.g. gs://bucket/prefix)"
            className="flex-1"
            disabled={isRunning}
          />
          <Button onClick={startPipeline} disabled={!sourcePath || isRunning}>
            <Play className="mr-2 h-4 w-4" /> Start
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">or</span>
          <input
            ref={folderInputRef}
            id="folder-input"
            type="file"
            // @ts-expect-error webkitdirectory is non-standard but widely supported
            webkitdirectory=""
            multiple
            className="absolute w-0 h-0 overflow-hidden opacity-0"
            onChange={handleFolderSelect}
            disabled={isRunning}
          />
          <label
            htmlFor={isRunning ? undefined : "folder-input"}
            className={`inline-flex shrink-0 items-center justify-center rounded-lg border border-border bg-background px-2.5 h-8 text-sm font-medium transition-all cursor-pointer hover:bg-muted hover:text-foreground ${isRunning ? 'opacity-50 pointer-events-none' : ''}`}
          >
            <FolderOpen className="mr-2 h-4 w-4" /> Select Local Folder
          </label>
        </div>
      </div>

      {status && (
        <Card className="p-6 space-y-4">
          <div className="flex items-center gap-3">
            <span className="font-medium">Status:</span>
            <Badge variant={status.running ? 'default' : 'secondary'}>
              {status.running ? 'In Progress' : 'Completed'}
            </Badge>
            {status.currentFile && (
              <span className="text-sm text-muted-foreground">Current: {status.currentFile}</span>
            )}
          </div>

          <Progress value={progress} className="h-3" />
          <p className="text-sm text-muted-foreground">
            {status.completed} / {status.total} files ({progress.toFixed(0)}%)
          </p>

          <div className="flex gap-4 text-sm">
            <span className="text-green-600">Success: {status.succeeded}</span>
            <span className="text-red-600">Failed: {status.failed}</span>
            <span className="text-muted-foreground">Pending: {status.total - status.completed}</span>
          </div>

          <ScrollArea className="h-48 border rounded p-3">
            {status.logs.map((log, i) => (
              <div key={i} className="flex items-center gap-2 py-1 text-sm">
                <span>{log.status === 'success' ? '\u2705' : '\u274C'}</span>
                <span className="flex-1 truncate">{log.fileName}</span>
                <span className="text-muted-foreground">{(log.duration / 1000).toFixed(1)}s</span>
                {log.message && <span className="text-red-500 text-xs truncate max-w-48">{log.message}</span>}
              </div>
            ))}
          </ScrollArea>
        </Card>
      )}
    </div>
  );
}
