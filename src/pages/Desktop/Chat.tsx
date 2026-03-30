import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Circle, MessageSquarePlus, RotateCw, Send, User, WifiOff } from 'lucide-react';
import { Button, Card, EmptyState, Input } from '@/components/ui';
import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { listProjects } from '@/api/projects';
import { createSession, getSession, listSessions, type Session } from '@/api/sessions';
import {
  bridgeConnect,
  bridgeSendMessage,
  getRuntimeStatus,
  onBridgeEvent,
  onRuntimeEvent,
  startDesktopService,
} from '@/api/desktop';
import { cn } from '@/lib/utils';
import type { DesktopBridgeEvent, DesktopRuntimeStatus } from '../../../shared/desktop';

const ASSISTANT_REPLY_TIMEOUT_MS = 90000;

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  kind?: 'final' | 'progress';
  preview?: boolean;
}

function isInternalProgressMessage(content?: string) {
  if (!content) {
    return false;
  }
  return (
    content.startsWith('💭 ') ||
    content.startsWith('🔧 ') ||
    content.startsWith('📤 ') ||
    content.startsWith('⏳ ')
  );
}

function sessionMatchesDesktop(session: Session) {
  return session.platform === 'desktop' || session.session_key.startsWith('desktop:');
}

function toMessages(history: { role: string; content: string; timestamp: string }[]): ChatMessage[] {
  return history.map((message, index) => ({
    id: `${index}-${message.timestamp || message.role}`,
    role: message.role === 'user' ? 'user' : 'assistant',
    content: message.content,
    kind: 'final',
  }));
}

export default function DesktopChat() {
  const [runtime, setRuntime] = useState<DesktopRuntimeStatus | null>(null);
  const [projects, setProjects] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [activeSessionKey, setActiveSessionKey] = useState('');
  const [activeSessionName, setActiveSessionName] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [typing, setTyping] = useState(false);
  const [bridgeError, setBridgeError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const replyTimeoutRef = useRef<number | null>(null);

  const serviceRunning = runtime?.service.status === 'running';
  const bridgeConnected = runtime?.bridge.status === 'connected';
  const desktopSessions = useMemo(() => sessions.filter(sessionMatchesDesktop), [sessions]);

  const clearReplyTimeout = useCallback(() => {
    if (replyTimeoutRef.current) {
      window.clearTimeout(replyTimeoutRef.current);
      replyTimeoutRef.current = null;
    }
  }, []);

  const armReplyTimeout = useCallback(() => {
    clearReplyTimeout();
    replyTimeoutRef.current = window.setTimeout(() => {
      setTyping(false);
      setBridgeError('Agent did not respond in time. Check Desktop Runtime logs or adjust the model/provider.');
    }, ASSISTANT_REPLY_TIMEOUT_MS);
  }, [clearReplyTimeout]);

  const refreshSessions = useCallback(async (project = selectedProject) => {
    if (!project || !serviceRunning) {
      setSessions([]);
      return;
    }
    const data = await listSessions(project);
    setSessions((data.sessions || []).filter(sessionMatchesDesktop));
  }, [selectedProject, serviceRunning]);

  const loadActiveSession = useCallback(async (project: string, sessionId: string) => {
    if (!project || !sessionId || !serviceRunning) {
      return;
    }
    const detail = await getSession(project, sessionId, 200);
    setActiveSessionId(detail.id);
    setActiveSessionKey(detail.session_key);
    setActiveSessionName(detail.name);
    setMessages(toMessages(detail.history || []));
  }, [serviceRunning]);

  const refreshRuntime = useCallback(async () => {
    const nextRuntime = await getRuntimeStatus();
    setRuntime(nextRuntime);
    if (!nextRuntime.service.lastError && nextRuntime.settings.defaultProject && !selectedProject) {
      setSelectedProject(nextRuntime.settings.defaultProject);
    }
  }, [selectedProject]);

  const refreshProjects = useCallback(async () => {
    if (!serviceRunning) {
      setProjects([]);
      return;
    }
    const result = await listProjects();
    const names = (result.projects || []).map((project) => project.name);
    setProjects(names);
    setSelectedProject((current) => current || runtime?.settings.defaultProject || names[0] || '');
  }, [runtime?.settings.defaultProject, serviceRunning]);

  useEffect(() => {
    if (!serviceRunning) {
      setSessions([]);
      setMessages([]);
      setBridgeError('');
      clearReplyTimeout();
      return;
    }
    void refreshProjects();
    void bridgeConnect();
  }, [clearReplyTimeout, refreshProjects, serviceRunning]);

  useEffect(() => {
    if (!selectedProject || !serviceRunning) {
      return;
    }
    setActiveSessionId('');
    setActiveSessionKey('');
    setActiveSessionName('');
    setMessages([]);
    setTyping(false);
    setBridgeError('');
    clearReplyTimeout();
    void refreshSessions(selectedProject);
  }, [clearReplyTimeout, selectedProject, refreshSessions, serviceRunning]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typing]);

  const handleBridgeEvent = useCallback((event: DesktopBridgeEvent) => {
    if (!event.sessionKey || event.sessionKey !== activeSessionKey) {
      if (event.sessionKey?.startsWith(`desktop:${selectedProject}:`)) {
        void refreshSessions(selectedProject);
      }
      return;
    }

    switch (event.type) {
      case 'preview_start':
        clearReplyTimeout();
        setTyping(false);
        setBridgeError('');
        setMessages((current) => [
          ...current.filter((message) => !(message.preview && message.id === event.previewHandle)),
          {
            id: event.previewHandle || crypto.randomUUID(),
            role: 'assistant',
            content: event.content || '',
            kind: 'progress',
            preview: true,
          },
        ]);
        break;
      case 'update_message':
        clearReplyTimeout();
        setTyping(false);
        setBridgeError('');
        setMessages((current) =>
          current.map((message) =>
            message.id === event.previewHandle ? { ...message, content: event.content || '' } : message,
          ),
        );
        break;
      case 'delete_message':
        clearReplyTimeout();
        setMessages((current) => current.filter((message) => message.id !== event.previewHandle));
        break;
      case 'typing_start':
        setTyping(true);
        setBridgeError('');
        armReplyTimeout();
        break;
      case 'typing_stop':
        setTyping(false);
        clearReplyTimeout();
        break;
      case 'reply':
        if (isInternalProgressMessage(event.content)) {
          const progressId = `${event.replyCtx || crypto.randomUUID()}-progress`;
          setTyping(true);
          setBridgeError('');
          armReplyTimeout();
          setMessages((current) => {
            const next = current.filter((message) => message.id !== progressId);
            next.push({
              id: progressId,
              role: 'assistant',
              content: event.content || '',
              kind: 'progress',
            });
            return next;
          });
          return;
        }
        clearReplyTimeout();
        setTyping(false);
        setBridgeError('');
        setMessages((current) => [
          ...current.filter((message) => !message.preview),
          {
            id: `${event.replyCtx || crypto.randomUUID()}-reply-final`,
            role: 'assistant',
            content: event.content || '',
            kind: 'final',
          },
        ]);
        void refreshSessions(selectedProject);
        break;
      case 'card':
        clearReplyTimeout();
        setBridgeError('');
        setMessages((current) => [
          ...current,
          {
            id: `${event.replyCtx || crypto.randomUUID()}-card`,
            role: 'assistant',
            content: 'Interactive card received. Open the session in the standard Sessions view for full controls.',
          },
        ]);
        break;
      default:
        break;
    }
  }, [activeSessionKey, armReplyTimeout, clearReplyTimeout, refreshSessions, selectedProject]);

  useEffect(() => {
    void refreshRuntime().finally(() => setLoading(false));
    const stopRuntime = onRuntimeEvent((nextRuntime) => {
      setRuntime(nextRuntime);
    });
    const stopBridge = onBridgeEvent((event) => {
      handleBridgeEvent(event);
    });
    return () => {
      clearReplyTimeout();
      stopRuntime();
      stopBridge();
    };
  }, [clearReplyTimeout, handleBridgeEvent, refreshRuntime]);

  const ensureSession = useCallback(async () => {
    if (!selectedProject) {
      throw new Error('Choose a project first');
    }
    if (activeSessionId && activeSessionKey) {
      return { id: activeSessionId, sessionKey: activeSessionKey };
    }

    const chatId = crypto.randomUUID().slice(0, 8);
    const sessionKey = `desktop:${selectedProject}:${chatId}`;
    const created = await createSession(selectedProject, {
      session_key: sessionKey,
      name: `Desktop ${new Date().toLocaleTimeString()}`,
    });
    const refreshed = await listSessions(selectedProject);
    const desktopOnly = (refreshed.sessions || []).filter(sessionMatchesDesktop);
    setSessions(desktopOnly);
    const matched = desktopOnly.find((session) => session.session_key === sessionKey);
    const nextId = created.id || matched?.id || '';
    setActiveSessionId(nextId);
    setActiveSessionKey(sessionKey);
    setActiveSessionName(created.name);
    if (nextId) {
      await loadActiveSession(selectedProject, nextId);
    } else {
      setMessages([]);
    }
    return { id: nextId, sessionKey };
  }, [activeSessionId, activeSessionKey, loadActiveSession, selectedProject]);

  const handleSend = useCallback(async () => {
    if (!draft.trim() || !selectedProject) {
      return;
    }
    const content = draft.trim();
    setDraft('');
    setSending(true);

    try {
      const ensured = await ensureSession();
      setMessages((current) => [
        ...current,
        { id: `${crypto.randomUUID()}-user`, role: 'user', content },
      ]);
      await bridgeSendMessage({
        project: selectedProject,
        chatId: ensured.sessionKey.split(':')[2] || 'main',
        content,
      });
      setTyping(true);
    } finally {
      setSending(false);
    }
  }, [draft, ensureSession, selectedProject]);

  const handleCreateNew = useCallback(async () => {
    setActiveSessionId('');
    setActiveSessionKey('');
    setActiveSessionName('');
    setMessages([]);
    setTyping(false);
    setBridgeError('');
    clearReplyTimeout();
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-400 animate-pulse">Loading...</div>;
  }

  return (
    <div className="grid grid-cols-[320px_minmax(0,1fr)] gap-6 h-[calc(100vh-8rem)] animate-fade-in">
      <Card className="overflow-hidden p-0 flex flex-col">
        <div className="p-5 border-b border-gray-200/80 dark:border-white/[0.08] space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Desktop Chat</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Use the desktop app as a live `bridge` channel.
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => void refreshRuntime()}>
              <RotateCw size={14} />
            </Button>
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Project</label>
            <select
              value={selectedProject}
              onChange={(event) => setSelectedProject(event.target.value)}
              data-testid="desktop-chat-project-select"
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300/90 dark:border-white/[0.1] bg-white/90 dark:bg-[rgba(0,0,0,0.45)] text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent/45 focus:border-accent"
            >
              <option value="">Select a project</option>
              {projects.map((project) => (
                <option key={project} value={project}>
                  {project}
                </option>
              ))}
            </select>
          </div>

          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void startDesktopService().then(refreshRuntime)}
              disabled={serviceRunning}
              data-testid="desktop-chat-start-service"
            >
              {serviceRunning ? 'Service Running' : 'Start Service'}
            </Button>
            <Button size="sm" variant="secondary" onClick={handleCreateNew} data-testid="desktop-chat-new-chat">
              <MessageSquarePlus size={14} /> New chat
            </Button>
          </div>

          {runtime?.service.lastError && (
            <div className="text-xs rounded-lg border border-red-200 bg-red-50 text-red-600 px-3 py-2 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
              {runtime.service.lastError}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {!selectedProject ? (
            <EmptyState message="Select a project to see desktop sessions." />
          ) : desktopSessions.length === 0 ? (
            <EmptyState message="No desktop sessions yet." />
          ) : (
            desktopSessions.map((session) => (
              <button
                key={session.id}
                onClick={() => void loadActiveSession(selectedProject, session.id)}
                className={cn(
                  'w-full text-left rounded-xl px-4 py-3 transition-colors border',
                  session.id === activeSessionId
                    ? 'border-accent/40 bg-accent/10'
                    : 'border-transparent bg-gray-100/70 dark:bg-white/[0.04] hover:bg-gray-100 dark:hover:bg-white/[0.08]',
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-sm text-gray-900 dark:text-white truncate">
                    {session.name}
                  </span>
                  {session.live ? (
                    <span className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                      <Circle size={6} className="fill-current" /> live
                    </span>
                  ) : (
                    <span className="text-[10px] text-gray-400">offline</span>
                  )}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-1">
                  {session.session_key}
                </p>
              </button>
            ))
          )}
        </div>
      </Card>

      <Card className="flex flex-col min-h-0">
        <div className="pb-4 border-b border-gray-200/80 dark:border-white/[0.08]">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            {activeSessionName || 'New desktop conversation'}
          </h2>
          <div className="flex items-center gap-2 mt-1 text-xs text-gray-500 dark:text-gray-400">
            {activeSessionKey ? <span>{activeSessionKey}</span> : <span>Create or select a session.</span>}
            {bridgeConnected ? (
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <Circle size={6} className="fill-current" /> bridge online
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <WifiOff size={12} /> bridge offline
              </span>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-6 space-y-5">
          {messages.length === 0 ? (
            <p className="text-center text-sm text-gray-400 py-12">
              Send a message to create a desktop session in the selected project.
            </p>
          ) : (
            messages.map((message) => {
              const isUser = message.role === 'user';
              return (
                <div key={message.id} className={cn('flex gap-3', isUser ? 'justify-end' : 'justify-start')}>
                  {!isUser && (
                    <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 mt-1">
                      <Bot size={16} className="text-accent" />
                    </div>
                  )}
                  <div
                    data-testid="desktop-chat-message"
                    data-role={message.role}
                    data-kind={message.kind || 'final'}
                    className={cn(
                      'rounded-2xl px-5 py-3.5 text-sm',
                      isUser
                        ? 'max-w-[70%] bg-accent text-black rounded-br-md'
                        : message.kind === 'progress'
                          ? 'max-w-[85%] bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40 text-amber-900 dark:text-amber-100 rounded-bl-md shadow-sm'
                        : 'max-w-[85%] bg-white dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700/60 text-gray-900 dark:text-gray-100 rounded-bl-md shadow-sm',
                    )}
                  >
                    {!isUser && message.kind === 'progress' && (
                      <p className="mb-2 text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-300">
                        process
                      </p>
                    )}
                    <ChatMarkdown content={message.content} isUser={isUser} />
                    {message.preview && (
                      <p className="mt-2 text-[10px] uppercase tracking-wide text-accent">stream preview</p>
                    )}
                  </div>
                  {isUser && (
                    <div className="w-8 h-8 rounded-lg bg-gray-200 dark:bg-gray-700 flex items-center justify-center shrink-0 mt-1">
                      <User size={16} className="text-gray-500" />
                    </div>
                  )}
                </div>
              );
            })
          )}

          {typing && (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <Circle size={8} className="fill-current animate-pulse" /> Agent is typing…
            </div>
          )}
          {bridgeError && (
            <div
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200"
              data-testid="desktop-chat-bridge-error"
            >
              {bridgeError}
            </div>
          )}
          <div ref={endRef} />
        </div>

        <div className="border-t border-gray-200/80 dark:border-white/[0.08] pt-4">
          <div className="flex gap-3">
            <Input
              data-testid="desktop-chat-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={serviceRunning ? 'Send a message to the desktop channel' : 'Start the service first'}
              disabled={!serviceRunning || sending || !selectedProject}
            />
            <Button
              onClick={() => void handleSend()}
              disabled={!draft.trim() || !serviceRunning || sending || !selectedProject}
              data-testid="desktop-chat-send"
            >
              <Send size={16} />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
