'use client';

import { useState, useCallback, useEffect } from 'react';
import { ChatSidebar } from '@/components/ChatSidebar';
import { ChatWindow } from '@/components/ChatWindow';
import { ChatInput } from '@/components/ChatInput';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { LogIn } from 'lucide-react';

interface Attachment {
  type: string;
  path: string;
  fileName: string;
  similarity: number;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
}

interface SseFrame {
  type: 'text_delta' | 'tool_call' | 'tool_result' | 'action_required' | 'error' | 'done';
  data?: unknown;
}

interface SseParseState {
  buffer: string;
  text: string;
  attachments: Attachment[];
  done: boolean;
  error: string | null;
}

function makeSseState(): SseParseState {
  return { buffer: '', text: '', attachments: [], done: false, error: null };
}

/** Append a chunk of SSE bytes and return updated cumulative state. Mutates state. */
function consumeSse(state: SseParseState, chunk: string): SseParseState {
  state.buffer += chunk;
  let idx: number;
  while ((idx = state.buffer.indexOf('\n\n')) !== -1) {
    const block = state.buffer.slice(0, idx);
    state.buffer = state.buffer.slice(idx + 2);
    const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) continue;
    let frame: SseFrame;
    try {
      frame = JSON.parse(dataLine.slice(5).trim()) as SseFrame;
    } catch {
      continue;
    }
    if (frame.type === 'text_delta' && typeof frame.data === 'string') {
      state.text += frame.data;
    } else if (frame.type === 'tool_result' && Array.isArray(frame.data)) {
      // search_documents returns an array of attachment-shaped objects.
      state.attachments = frame.data as Attachment[];
    } else if (frame.type === 'error') {
      const msg =
        frame.data && typeof frame.data === 'object' && 'message' in (frame.data as object)
          ? String((frame.data as { message: unknown }).message)
          : 'agent error';
      state.error = msg;
    } else if (frame.type === 'done') {
      state.done = true;
    }
  }
  return state;
}

function SapLoginModal({ onSuccess }: { onSuccess: (username: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password.trim()) return;
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/sap/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'basic', username, password }),
      });
      const data = await res.json();
      if (data.success && data.sap_user) {
        onSuccess(data.sap_user);
      } else {
        setError(data.error ?? 'Login failed. Please check your credentials.');
      }
    } catch {
      setError('Failed to connect to SAP service.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="w-full max-w-sm bg-card border border-border rounded-lg shadow-lg p-6">
        <h2 className="text-base font-semibold text-foreground mb-1">Sign in to SAP</h2>
        <p className="text-xs text-muted-foreground mb-4">Your conversations are scoped to your SAP user.</p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="sap-username" className="text-xs font-medium text-muted-foreground">Username</label>
            <Input
              id="sap-username"
              type="text"
              placeholder="SAP User ID"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              disabled={loading}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="sap-password" className="text-xs font-medium text-muted-foreground">Password</label>
            <Input
              id="sap-password"
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={loading}
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="submit" disabled={loading || !username.trim() || !password.trim()} className="mt-1">
            <LogIn className="h-4 w-4 mr-1.5" />
            {loading ? 'Connecting...' : 'Login to SAP'}
          </Button>
        </form>
      </div>
    </div>
  );
}

export default function ChatPage() {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState('');
  const [streamingAttachments, setStreamingAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingType, setLoadingType] = useState<'chat' | 'embedding'>('chat');
  const [sapAuthenticated, setSapAuthenticated] = useState<boolean | null>(null);
  const [sessionUser, setSessionUser] = useState<string | null>(null);
  const [sessionResolved, setSessionResolved] = useState(false);

  useEffect(() => {
    fetch('/api/sap/auth')
      .then((r) => r.json())
      .then((data) => {
        setSapAuthenticated(data.authenticated);
        setSessionUser(data.sap_user ?? null);
      })
      .catch(() => {
        setSapAuthenticated(false);
        setSessionUser(null);
      })
      .finally(() => setSessionResolved(true));
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    setConversationId(id);
    setMessages([]);
    const res = await fetch(`/api/conversations/${id}/messages`);
    if (res.status === 401) {
      setSessionUser(null);
      return;
    }
    if (!res.ok) {
      console.error('Failed to load messages', res.status);
      return;
    }
    const rows = (await res.json()) as Array<{
      id: string;
      role: string;
      content: string;
      attachments: Attachment[] | null;
    }>;
    setMessages(
      rows.map((r) => ({
        id: r.id,
        role: r.role as 'user' | 'assistant',
        content: r.content,
        attachments: r.attachments && r.attachments.length > 0 ? r.attachments : undefined,
      })),
    );
  }, []);

  async function createConversation(): Promise<string> {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.status === 401) {
      setSessionUser(null);
      throw new Error('NOT_AUTHENTICATED');
    }
    const conv = await res.json();
    setConversationId(conv.id);
    setMessages([]);
    return conv.id;
  }

  async function handleSend(message: string, file?: File) {
    if (!sessionUser) return;

    if (file && message.includes('embedding')) {
      const formData = new FormData();
      formData.append('file', file);
      setLoadingType('embedding');
      setLoading(true);
      const res = await fetch('/api/embed', { method: 'POST', body: formData });
      const result = await res.json();
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'user', content: `${file.name}\n${message}` },
        { id: crypto.randomUUID(), role: 'assistant', content: `File '${result.fileName}' has been successfully embedded. (${result.chunksCreated} chunks created)` },
      ]);
      setLoading(false);
      return;
    }

    let activeConvId = conversationId;
    if (!activeConvId) {
      try {
        activeConvId = await createConversation();
      } catch {
        return;
      }
    }

    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', content: message }]);
    setLoadingType('chat');
    setLoading(true);
    setStreaming('');
    setStreamingAttachments([]);

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, conversationId: activeConvId }),
    });

    if (res.status === 401) {
      setSessionUser(null);
      setLoading(false);
      return;
    }

    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    const state = makeSseState();

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeSse(state, decoder.decode(value, { stream: true }));
        if (state.attachments.length > 0) setStreamingAttachments(state.attachments);
        setStreaming(state.text);
        if (state.done) break;
      }
    }

    setStreaming('');
    setStreamingAttachments([]);
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: state.error ? `Error: ${state.error}` : state.text,
        attachments: state.attachments.length > 0 ? state.attachments : undefined,
      },
    ]);
    setLoading(false);
  }

  async function handleLogout() {
    await fetch('/api/sap/auth', { method: 'DELETE' });
    window.location.reload();
  }

  return (
    <div className="flex h-screen bg-background">
      <ChatSidebar
        activeId={conversationId}
        onSelect={loadMessages}
        onNew={() => { setConversationId(null); setMessages([]); }}
        sessionUser={sessionUser}
        onLogout={handleLogout}
      />
      <div className="flex-1 flex flex-col bg-card min-h-0">
        <ChatWindow
          messages={messages}
          streamingContent={streaming || undefined}
          streamingAttachments={streamingAttachments.length > 0 ? streamingAttachments : undefined}
          loading={loading}
          loadingType={loadingType}
        />
        <div className="px-6 py-1.5 flex items-center gap-4 text-xs text-muted-foreground border-t border-border/50">
          <span className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${sapAuthenticated ? 'bg-green-500' : 'bg-yellow-500'}`} />
            SAP {sapAuthenticated ? 'Connected' : 'Not connected'}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            Documents
          </span>
        </div>
        <ChatInput onSend={handleSend} disabled={loading || !sessionUser} />
      </div>
      {sessionResolved && !sessionUser && (
        <SapLoginModal onSuccess={(user) => { setSessionUser(user); setSapAuthenticated(true); }} />
      )}
    </div>
  );
}
