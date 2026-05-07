'use client';

import { useEffect, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Plus, Search, MessageSquare, Trash2 } from 'lucide-react';

interface Conversation {
  id: string;
  title: string;
  createdAt: string;
}

interface ChatSidebarProps {
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  sessionUser: string | null;
  onLogout: () => void;
}

export function ChatSidebar({ activeId, onSelect, onNew, sessionUser, onLogout }: ChatSidebarProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);

  useEffect(() => {
    if (!sessionUser) return;
    fetch('/api/conversations')
      .then(async (r) => (r.ok ? r.json() : []))
      .then(setConversations)
      .catch(() => setConversations([]));
  }, [activeId, sessionUser]);

  async function handleDelete(id: string) {
    await fetch(`/api/conversations?id=${id}`, { method: 'DELETE' });
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) onNew();
  }

  return (
    <div className="w-72 bg-sidebar flex flex-col h-full border-r border-sidebar-border">
      {/* Branding */}
      <div className="px-6 pt-6 pb-4">
        <h1 className="text-xl font-bold tracking-wide text-foreground">
          GEMINI <span className="text-primary">RAG</span>
        </h1>
      </div>

      {/* New Chat + Search */}
      <div className="px-4 pb-4 flex gap-2">
        <button
          onClick={onNew}
          className="flex-1 flex items-center justify-center gap-2 bg-primary text-primary-foreground rounded-full py-2.5 px-4 text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New chat
        </button>
        <button className="flex items-center justify-center w-10 h-10 rounded-full bg-card border border-border hover:bg-accent transition-colors">
          <Search className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      {/* Section Label */}
      <div className="px-6 py-2 flex items-center justify-between">
        <span className="text-xs text-muted-foreground font-medium">Your conversations</span>
      </div>

      {/* Conversation List */}
      <ScrollArea className="flex-1 px-2">
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={`group flex items-center gap-3 px-4 py-3 mx-1 rounded-lg cursor-pointer transition-colors ${
              activeId === conv.id
                ? 'bg-primary/10 text-primary'
                : 'text-foreground hover:bg-accent'
            }`}
            onClick={() => onSelect(conv.id)}
          >
            <MessageSquare className={`h-4 w-4 shrink-0 ${
              activeId === conv.id ? 'text-primary' : 'text-muted-foreground'
            }`} />
            <span className="truncate flex-1 text-sm">{conv.title}</span>
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(conv.id); }}
              className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </ScrollArea>

      {/* Footer */}
      <div className="p-4 border-t border-sidebar-border flex flex-col gap-2">
        {sessionUser && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="truncate">Logged in as <span className="text-foreground">{sessionUser}</span></span>
            <button
              onClick={onLogout}
              className="text-muted-foreground hover:text-destructive transition-colors"
            >
              Logout
            </button>
          </div>
        )}
        <a
          href="/admin/pipeline"
          className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Admin: Pipeline →
        </a>
      </div>
    </div>
  );
}
