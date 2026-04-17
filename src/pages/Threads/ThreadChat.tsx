import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  Circle,
  Database,
  LoaderCircle,
  MessageSquarePlus,
  Pencil,
  RotateCw,
  Search,
  Send,
  Trash2,
  User,
  WifiOff,
  X,
} from 'lucide-react';
import { Button, Input, Modal, Textarea } from '@/components/ui';
import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { startDesktopService } from '@/api/desktop';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/session-utils';
import type { DesktopBridgeButtonOption } from '../../../shared/desktop';
import { formatMessageTimestamp, formatRuntimePhase } from './thread-chat-model';
import { useThreadChatController } from './useThreadChatController';

export default function ThreadChat() {
  const [knowledgePickerOpen, setKnowledgePickerOpen] = useState(false);
  const knowledgePickerRef = useRef<HTMLDivElement>(null);
  const [knowledgeSearch, setKnowledgeSearch] = useState('');
  const {
    activeRunId,
    activeSessionId,
    activeSessionKey,
    activeSessionName,
    bridgeError,
    branding,
    deleteTarget,
    draft,
    endRef,
    filteredSessionGroups,
    handleBridgeAction,
    handleCreateNew,
    handleDeleteSession,
    handleRenameSession,
    handleSend,
    handleStopTask,
    availableKnowledgeBases,
    loadActiveSession,
    loading,
    openRenameModal,
    pendingBridgeActionId,
    pendingSessionAction,
    projects,
    refreshRuntime,
    renameDraft,
    renameTarget,
    renderedMessages,
    runtime,
    sending,
    selectedKnowledgeBaseIds,
    serviceRunning,
    sessionSearch,
    selectedProject,
    setDeleteTarget,
    setDraft,
    setSelectedKnowledgeBaseIds,
    setRenameDraft,
    setRenameTarget,
    setSelectedProject,
    setSessionSearch,
    showSessionKey,
    taskHint,
    taskInputLocked,
    taskRunning,
    taskState,
    transportReady,
  } = useThreadChatController();

  const selectedKnowledgeBases = useMemo(
    () =>
      selectedKnowledgeBaseIds.map((knowledgeBaseId) => {
        const matched = availableKnowledgeBases.find((base) => base.id === knowledgeBaseId);
        return {
          id: knowledgeBaseId,
          name: matched?.name || knowledgeBaseId,
          fileCount: matched?.fileCount || 0,
        };
      }),
    [availableKnowledgeBases, selectedKnowledgeBaseIds],
  );

  const filteredKnowledgeBases = useMemo(() => {
    const query = knowledgeSearch.trim().toLowerCase();
    if (!query) {
      return availableKnowledgeBases;
    }
    return availableKnowledgeBases.filter((base) =>
      [base.name, base.description, base.id].join(' ').toLowerCase().includes(query),
    );
  }, [availableKnowledgeBases, knowledgeSearch]);

  const orderedKnowledgeBases = useMemo(() => {
    const selectedIds = new Set(selectedKnowledgeBaseIds);
    return [...filteredKnowledgeBases].sort((a, b) => {
      const aSelected = selectedIds.has(a.id);
      const bSelected = selectedIds.has(b.id);
      if (aSelected !== bSelected) {
        return aSelected ? -1 : 1;
      }
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  }, [filteredKnowledgeBases, selectedKnowledgeBaseIds]);

  const visibleSessionGroups = useMemo(() => {
    if (!selectedProject) {
      return filteredSessionGroups;
    }
    return filteredSessionGroups.filter((group) => group.project === selectedProject);
  }, [filteredSessionGroups, selectedProject]);
  const visibleProjects = useMemo(
    () => (selectedProject && !projects.includes(selectedProject) ? [selectedProject, ...projects] : projects),
    [projects, selectedProject],
  );

  const hasVisibleSessions = useMemo(
    () => visibleSessionGroups.some((group) => group.sessions.length > 0),
    [visibleSessionGroups],
  );

  const isRuntimeStarting = runtime?.phase === 'starting';
  const selectedKnowledgeCount = selectedKnowledgeBaseIds.length;
  const permissionPromptMessage = useMemo(
    () =>
      [...renderedMessages]
        .reverse()
        .find((message) => message.role === 'assistant' && message.actionMode === 'permission' && message.actionInteractive),
    [renderedMessages],
  );
  const fallbackPermissionActions = useMemo<DesktopBridgeButtonOption[][]>(
    () => [[
      { text: '允许', data: 'allow' },
      { text: '拒绝', data: 'deny' },
      { text: '始终允许', data: 'allow all' },
    ]],
    [],
  );
  const visiblePermissionActions =
    permissionPromptMessage?.actions && permissionPromptMessage.actions.length > 0
      ? permissionPromptMessage.actions
      : fallbackPermissionActions;

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!knowledgePickerRef.current?.contains(event.target as Node)) {
        setKnowledgePickerOpen(false);
      }
    };
    if (knowledgePickerOpen) {
      document.addEventListener('mousedown', handlePointerDown);
    }
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [knowledgePickerOpen]);

  useEffect(() => {
    if (!knowledgePickerOpen) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const input = knowledgePickerRef.current?.querySelector('input');
      if (input instanceof HTMLInputElement) {
        input.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [knowledgePickerOpen]);

  if (loading) {
    return <div className="flex h-64 items-center justify-center text-sm text-slate-500 animate-pulse">正在加载桌面对话…</div>;
  }

  return (
    <>
      <div className="h-full overflow-hidden rounded-[28px] border border-slate-200/80 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.06)] animate-fade-in dark:border-white/[0.06] dark:bg-[#0b0f14] dark:shadow-[0_20px_70px_rgba(0,0,0,0.28)]">
        <div className="grid h-full grid-cols-[288px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col border-r border-slate-200/80 bg-[linear-gradient(180deg,#fbfcfe_0%,#f5f7fb_100%)] dark:border-white/[0.06] dark:bg-[linear-gradient(180deg,#10151c_0%,#0c1016_100%)]">
            <div className="border-b border-slate-200/80 px-4 py-4 dark:border-white/[0.06]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-medium tracking-[0.18em] text-slate-400 dark:text-slate-500">会话导航</p>
                  <h2 className="mt-2 text-[1.7rem] font-semibold leading-tight text-slate-900 dark:text-white">
                    {branding.chatHeading}
                  </h2>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void refreshRuntime()}
                  className="rounded-full border border-slate-200 bg-white text-slate-500 hover:bg-slate-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-slate-300 dark:hover:bg-white/[0.08]"
                >
                  <RotateCw size={14} />
                </Button>
              </div>

              <div className="mt-4 space-y-3">
                <div className="space-y-2">
                  <label className="block text-[11px] font-medium tracking-[0.18em] text-slate-400 dark:text-slate-500">
                    {branding.scopeLabel}
                  </label>
                  <select
                    value={selectedProject}
                    onChange={(event) => setSelectedProject(event.target.value)}
                    data-testid="desktop-chat-project-select"
                    className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-emerald-400/50 focus:ring-2 focus:ring-emerald-400/15 dark:border-white/[0.08] dark:bg-[#0b1016] dark:text-white"
                  >
                    <option value="">{branding.scopeSelectPlaceholder}</option>
                    {visibleProjects.map((project) => (
                      <option key={project} value={project}>
                        {project}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    size="md"
                    variant="secondary"
                    onClick={() => void handleCreateNew()}
                    data-testid="desktop-chat-new-chat"
                    className="h-11 flex-1 rounded-2xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-slate-100 dark:hover:bg-white/[0.09]"
                  >
                    <MessageSquarePlus size={15} />
                    {branding.newThreadLabel}
                  </Button>
                  {!serviceRunning || isRuntimeStarting ? (
                    <Button
                      size="md"
                      onClick={() => void startDesktopService().then(refreshRuntime)}
                      disabled={isRuntimeStarting || serviceRunning}
                      data-testid="desktop-chat-start-service"
                      className="h-11 shrink-0 rounded-2xl px-3.5"
                    >
                      {isRuntimeStarting ? branding.startingRuntimeLabel : branding.startRuntimeLabel}
                    </Button>
                  ) : null}
                </div>

                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
                  <Input
                    value={sessionSearch}
                    onChange={(event) => setSessionSearch(event.target.value)}
                    placeholder={branding.searchPlaceholder}
                    data-testid="desktop-chat-session-search"
                    className="h-11 rounded-2xl border-slate-200 bg-white pl-9 text-slate-900 placeholder:text-slate-400 dark:border-white/[0.08] dark:bg-[#0b1016] dark:text-white dark:placeholder:text-slate-500"
                  />
                </div>

                <div className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200/80 bg-white/85 px-3 py-2 dark:border-white/[0.06] dark:bg-white/[0.03]">
                  <span className="inline-flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                    <Circle size={7} className={cn('fill-current', serviceRunning ? 'text-emerald-500' : 'text-slate-300 dark:text-slate-500')} />
                    {serviceRunning ? '服务在线' : isRuntimeStarting ? '服务启动中' : '服务未启动'}
                  </span>
                </div>
              </div>

              {runtime?.service.lastError ? (
                <div className="mt-3 rounded-2xl border border-red-500/20 bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-500/10 dark:text-red-200">
                  {runtime.service.lastError}
                </div>
              ) : null}
              {runtime?.pendingRestart ? (
                <div className="mt-3 rounded-2xl border border-amber-500/20 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-200">
                  {branding.pendingRestartLabel}
                </div>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 [scrollbar-gutter:stable]">
              {!selectedProject && !hasVisibleSessions ? (
                <div className="rounded-2xl border border-dashed border-slate-200/80 bg-white/70 px-4 py-6 text-center dark:border-white/[0.07] dark:bg-white/[0.02]">
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200">先选择一个项目</p>
                  <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                    选择项目后展示对应会话列表。
                  </p>
                </div>
              ) : !hasVisibleSessions ? (
                <div className="rounded-2xl border border-dashed border-slate-200/80 bg-white/70 px-4 py-6 text-center dark:border-white/[0.07] dark:bg-white/[0.02]">
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                    {sessionSearch.trim() ? '没有匹配的会话' : '当前还没有桌面会话'}
                  </p>
                  <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                    {sessionSearch.trim() ? '换个关键词试试。' : '发送第一条消息后，这里会出现新的会话记录。'}
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {visibleSessionGroups.map((group) => (
                    <section key={group.project} className="space-y-2">
                      {!selectedProject && group.sessions.length > 0 ? (
                        <div
                          data-testid="desktop-chat-session-group"
                          data-project={group.project}
                          className="flex items-center justify-between px-2 pt-1"
                        >
                          <p className="text-[11px] font-medium tracking-[0.08em] text-slate-400 dark:text-slate-500">{group.project}</p>
                          <p className="text-[10px] text-slate-400 dark:text-slate-500">
                            {group.sessions.length} {branding.collectionLabel}
                          </p>
                        </div>
                      ) : null}

                      {group.sessions.map((session) => (
                        <div
                          key={session.id}
                          data-testid="desktop-chat-session-row"
                          data-session-id={session.id}
                          data-project={group.project}
                          role="button"
                          tabIndex={0}
                          onClick={() => void loadActiveSession(group.project, session.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              void loadActiveSession(group.project, session.id);
                            }
                          }}
                          className={cn(
                            'group relative overflow-hidden rounded-2xl border px-4 py-3 text-left transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-emerald-400/20',
                            session.id === activeSessionId
                              ? 'border-emerald-200 bg-emerald-50/80 shadow-[inset_3px_0_0_0_rgba(16,185,129,0.9)] dark:border-emerald-400/20 dark:bg-emerald-500/10'
                              : 'border-transparent bg-white/70 hover:border-slate-200 hover:bg-white dark:bg-white/[0.03] dark:hover:border-white/[0.08] dark:hover:bg-white/[0.05]',
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div
                              data-testid="desktop-chat-session-open"
                              data-session-id={session.id}
                              data-project={group.project}
                              className="min-w-0 flex-1"
                            >
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium text-slate-900 dark:text-white">{session.name}</span>
                                <span
                                  className={cn(
                                    'shrink-0 rounded-full px-2 py-0.5 text-[10px]',
                                    session.live
                                      ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                                      : 'bg-slate-100 text-slate-500 dark:bg-white/[0.05] dark:text-slate-400',
                                  )}
                                >
                                  {session.live ? '在线' : '离线'}
                                </span>
                              </div>
                              <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                                {timeAgo(session.updatedAt || session.createdAt)}
                              </p>
                              {session.excerpt ? (
                                <p className="mt-2 line-clamp-2 text-[11px] leading-5 text-slate-500 dark:text-slate-400">
                                  {session.excerpt.replace(/\n/g, ' ')}
                                </p>
                              ) : null}
                              {showSessionKey && session.bridgeSessionKey ? (
                                <p className="mt-2 truncate text-[11px] text-slate-400 dark:text-slate-500">
                                  {session.bridgeSessionKey}
                                </p>
                              ) : null}
                            </div>

                            <div className="flex items-center gap-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openRenameModal(group.project, session);
                                }}
                                data-testid="desktop-chat-session-rename"
                                data-session-id={session.id}
                                data-project={group.project}
                                className="text-slate-400 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-white/[0.08] dark:hover:text-white"
                              >
                                <Pencil size={14} />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-red-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-200"
                                data-testid="desktop-chat-session-delete"
                                data-session-id={session.id}
                                data-project={group.project}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setDeleteTarget({
                                    project: group.project,
                                    id: session.id,
                                    name: session.name,
                                  });
                                }}
                              >
                                <Trash2 size={14} />
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </section>
                  ))}
                </div>
              )}
            </div>
          </aside>

          <section className="flex min-h-0 flex-col bg-[linear-gradient(180deg,#ffffff_0%,#fbfcfe_100%)] dark:bg-[linear-gradient(180deg,#0d1218_0%,#0a0f15_100%)]">
            <div className="border-b border-slate-200/80 px-6 py-4 dark:border-white/[0.06]">
              <p className="text-[11px] font-medium tracking-[0.16em] text-slate-400 dark:text-slate-500">当前会话</p>
              <h2
                className="mt-2 text-[2rem] font-semibold leading-none text-slate-900 dark:text-white"
                data-testid="desktop-chat-active-title"
              >
                {activeSessionName || branding.activeConversationFallback}
              </h2>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                {selectedProject ? (
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600 dark:bg-white/[0.05] dark:text-slate-300">
                    {selectedProject}
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-500 dark:bg-white/[0.05] dark:text-slate-400">
                  {formatRuntimePhase(runtime?.phase)}
                </span>
                {transportReady ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-emerald-700 dark:text-emerald-300">
                    <Circle size={6} className="fill-current" /> {branding.runtimeOnlineLabel}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-slate-500 dark:bg-white/[0.05] dark:text-slate-400">
                    <WifiOff size={12} /> {branding.runtimeOfflineLabel}
                  </span>
                )}
                {showSessionKey && activeSessionKey ? (
                  <span className="truncate text-[11px] text-slate-400 dark:text-slate-500">{activeSessionKey}</span>
                ) : null}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5 [scrollbar-gutter:stable]">
              {renderedMessages.length === 0 ? (
                <div className="flex h-full min-h-[18rem] items-center justify-center">
                  <div className="w-full max-w-2xl rounded-[28px] border border-slate-200/80 bg-white px-8 py-10 text-center shadow-[0_10px_30px_rgba(15,23,42,0.04)] dark:border-white/[0.06] dark:bg-white/[0.03] dark:shadow-none">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-500">
                      <MessageSquarePlus size={22} />
                    </div>
                    <h3 className="mt-4 text-xl font-semibold text-slate-900 dark:text-white">开始一段新的桌面对话</h3>
                    <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-slate-500 dark:text-slate-400">
                      {selectedProject
                        ? `当前项目是 ${selectedProject}。直接提问即可创建会话并开始对话。`
                        : '先在左侧选择项目，然后直接输入你的问题。'}
                    </p>
                    <div className="mt-4 flex flex-wrap justify-center gap-2">
                      {selectedKnowledgeBases.length > 0 ? (
                        selectedKnowledgeBases.map((base) => (
                          <span
                            key={base.id}
                            className="rounded-full bg-emerald-50 px-3 py-1 text-xs text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200"
                          >
                            {base.name}
                          </span>
                        ))
                      ) : (
                        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500 dark:bg-white/[0.05] dark:text-slate-400">
                          当前未限制知识库范围
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-5">
                  {renderedMessages.map((message) => {
                    const isUser = message.role === 'user';
                    const isProgress = !isUser && message.kind === 'progress';
                    return (
                      <div key={message.id} className={cn('flex gap-3', isUser ? 'justify-end' : 'justify-start')}>
                        {!isUser ? (
                          <div
                            className={cn(
                              'mt-1 flex shrink-0 items-center justify-center rounded-full text-slate-400 dark:text-slate-500',
                              isProgress
                                ? 'h-6 w-6 bg-slate-100 dark:bg-white/[0.04]'
                                : 'h-8 w-8 bg-slate-100 dark:bg-white/[0.06]',
                            )}
                          >
                            {isProgress ? <Circle size={7} className="fill-current" /> : <Bot size={14} />}
                          </div>
                        ) : null}

                        <div
                          data-testid="desktop-chat-message"
                          data-role={message.role}
                          data-kind={message.kind || 'final'}
                          data-order={String(message.order)}
                          data-timestamp={message.timestamp || ''}
                          className={cn(
                            'transition-all',
                            isUser ? 'max-w-[72%]' : isProgress ? 'max-w-[76%]' : 'max-w-[84%]',
                          )}
                        >
                          <div
                            className={cn(
                              'rounded-[22px] px-4 py-3 text-sm',
                              isUser
                                ? 'rounded-br-md bg-emerald-400/95 text-black shadow-none'
                                : isProgress
                                  ? 'rounded-bl-lg bg-slate-100/80 text-[13px] leading-6 text-slate-500 dark:bg-white/[0.04] dark:text-slate-400'
                                  : 'rounded-bl-md border border-slate-200/80 bg-white text-slate-800 shadow-[0_6px_18px_rgba(15,23,42,0.04)] dark:border-white/[0.06] dark:bg-white/[0.04] dark:text-slate-100 dark:shadow-none',
                            )}
                          >
                            <div className={cn('mb-2 flex items-center gap-2 text-[10px]', isUser ? 'justify-end text-black/60' : 'text-slate-400 dark:text-slate-500')}>
                              {isProgress ? (
                                <span className="tracking-[0.16em] text-amber-500 dark:text-amber-300">过程</span>
                              ) : null}
                              {formatMessageTimestamp(message.timestamp) ? (
                                <span data-testid="desktop-chat-message-timestamp">{formatMessageTimestamp(message.timestamp)}</span>
                              ) : null}
                            </div>
                            {!isUser && message.preview && message.previewPlainText ? (
                              <div className="whitespace-pre-wrap break-words text-[13px] leading-6 text-inherit">
                                {message.content}
                              </div>
                            ) : (
                              <ChatMarkdown content={message.content} isUser={isUser} />
                            )}
                            {!isUser && message.actions && message.actions.length > 0 ? (
                              <div className="mt-4 space-y-2">
                                {message.actions.map((row, rowIndex) => (
                                  <div key={`${message.id}-actions-${rowIndex}`} className="flex flex-wrap gap-2">
                                    {row.map((action) => (
                                      <Button
                                        key={`${message.id}-${action.data || action.text}`}
                                        size="sm"
                                        variant={String(action.data || '').includes('deny') ? 'danger' : 'secondary'}
                                        onClick={() => void handleBridgeAction(message, action)}
                                        disabled={Boolean(message.actionPending || pendingBridgeActionId)}
                                        loading={pendingBridgeActionId === message.id}
                                        data-testid="desktop-chat-action-button"
                                        className="rounded-full"
                                      >
                                        {action.text || action.data}
                                      </Button>
                                    ))}
                                  </div>
                                ))}
                              </div>
                            ) : null}
                            {!isUser && message.actionStatus ? (
                              <p
                                className={cn(
                                  'mt-3 text-xs',
                                  message.actionInteractive
                                    ? 'text-slate-500 dark:text-slate-400'
                                    : 'text-amber-700 dark:text-amber-200',
                                )}
                                data-testid="desktop-chat-action-status"
                              >
                                {message.actionStatus}
                              </p>
                            ) : null}
                            {message.preview ? (
                              <p className="mt-2 text-[10px] uppercase tracking-[0.18em] text-emerald-500 dark:text-emerald-300">实时预览</p>
                            ) : null}
                          </div>
                        </div>

                        {isUser ? (
                          <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 dark:bg-white/[0.08]">
                            <User size={14} className="text-slate-500 dark:text-slate-300" />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}

              {taskHint ? (
                <div className="mt-5 flex items-center gap-2 text-sm text-slate-400" data-testid="desktop-chat-task-hint">
                  <Circle size={8} className="fill-current animate-pulse" /> {taskHint}
                </div>
              ) : null}
              {bridgeError ? (
                <div
                  className="mt-4 rounded-2xl border border-amber-400/20 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-100"
                  data-testid="desktop-chat-bridge-error"
                >
                  {bridgeError}
                </div>
              ) : null}
              <div ref={endRef} />
            </div>

            <div className="border-t border-slate-200/80 px-6 py-3 dark:border-white/[0.06]">
              <div className="rounded-[24px] border border-slate-200/80 bg-white p-2.5 shadow-[0_8px_24px_rgba(15,23,42,0.05)] dark:border-white/[0.08] dark:bg-[#0f151c] dark:shadow-[0_12px_28px_rgba(0,0,0,0.20)]">
                <div className="relative" ref={knowledgePickerRef}>
                  <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-1.5 dark:border-white/[0.06] dark:bg-white/[0.03]">
                    <div className="flex items-center gap-2">
                      <p className="shrink-0 text-[11px] font-medium text-slate-500 dark:text-slate-400">知识库范围</p>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!selectedProject}
                        onClick={() => setKnowledgePickerOpen((current) => !current)}
                        data-testid="desktop-chat-knowledge-base-toggle"
                        className="shrink-0 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-slate-100 dark:hover:bg-white/[0.1]"
                      >
                        <Database size={13} />
                        {selectedKnowledgeCount > 0 ? '调整知识库' : '选择知识库'}
                      </Button>
                      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto whitespace-nowrap [scrollbar-gutter:stable]">
                        {selectedKnowledgeBases.length === 0 ? (
                          <span className="text-xs text-slate-400">
                            {selectedProject ? '当前未限制知识库范围' : '选择项目后可设置知识库范围'}
                          </span>
                        ) : (
                          selectedKnowledgeBases.map((base) => (
                            <span
                              key={base.id}
                              className="inline-flex shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-slate-100"
                            >
                              <span className="max-w-[10rem] truncate">{base.name}</span>
                              {base.fileCount > 0 ? <span className="text-[10px] text-slate-500">{base.fileCount} 文档</span> : null}
                              <button
                                type="button"
                                onClick={() => void setSelectedKnowledgeBaseIds(selectedKnowledgeBaseIds.filter((id) => id !== base.id))}
                                className="text-slate-500 transition-colors hover:text-slate-900 dark:hover:text-white"
                                data-testid="desktop-chat-knowledge-base-remove"
                              >
                                <X size={12} />
                              </button>
                            </span>
                          ))
                        )}
                      </div>
                      <p className="shrink-0 text-[11px] text-slate-400">
                        {selectedProject
                          ? selectedKnowledgeCount > 0
                            ? `已选 ${selectedKnowledgeCount} 个`
                            : '未限制'
                          : '请先选项目'}
                      </p>
                    </div>
                  </div>

                  {knowledgePickerOpen ? (
                    <div className="animate-float-in absolute bottom-full left-0 right-0 z-20 mb-3 rounded-[24px] border border-slate-200 bg-white p-3 shadow-[0_22px_50px_rgba(15,23,42,0.12)] dark:border-white/[0.08] dark:bg-[#0c1117] dark:shadow-[0_28px_80px_rgba(0,0,0,0.40)]">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-slate-900 dark:text-white">选择知识库</p>
                          <p className="text-[11px] text-slate-400">已选项排在前面，方便快速确认范围。</p>
                        </div>
                        {selectedKnowledgeCount > 0 ? (
                          <button
                            type="button"
                            onClick={() => void setSelectedKnowledgeBaseIds([])}
                            className="text-xs text-slate-400 transition-colors hover:text-slate-900 dark:hover:text-white"
                          >
                            清空
                          </button>
                        ) : null}
                      </div>
                      <Input
                        value={knowledgeSearch}
                        onChange={(event) => setKnowledgeSearch(event.target.value)}
                        placeholder="搜索知识库"
                        className="mt-3 rounded-2xl border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white dark:placeholder:text-slate-500"
                      />
                      <div className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-2 [scrollbar-gutter:stable]">
                        {orderedKnowledgeBases.length === 0 ? (
                          <div className="rounded-xl border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-500 dark:border-white/[0.08]">
                            没有匹配的知识库
                          </div>
                        ) : (
                          orderedKnowledgeBases.map((base) => {
                            const checked = selectedKnowledgeBaseIds.includes(base.id);
                            return (
                              <button
                                key={base.id}
                                type="button"
                                onClick={() =>
                                  void setSelectedKnowledgeBaseIds(
                                    checked
                                      ? selectedKnowledgeBaseIds.filter((id) => id !== base.id)
                                      : [...selectedKnowledgeBaseIds, base.id],
                                  )
                                }
                                data-testid="desktop-chat-knowledge-base-select"
                                className={cn(
                                  'flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition-all duration-200',
                                  checked
                                    ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-400/30 dark:bg-emerald-500/12'
                                    : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-white/[0.06] dark:bg-white/[0.03] dark:hover:border-white/[0.12] dark:hover:bg-white/[0.05]',
                                )}
                              >
                                <span
                                  className={cn(
                                    'mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border text-[10px]',
                                    checked
                                      ? 'border-emerald-500 bg-emerald-500 text-white'
                                      : 'border-slate-300 text-transparent dark:border-white/[0.12]',
                                  )}
                                >
                                  <Check size={12} />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm font-medium text-slate-900 dark:text-white">{base.name}</span>
                                  <span className="mt-1 block text-[11px] text-slate-400">
                                    {base.fileCount} 文档
                                    {base.description ? ` · ${base.description}` : ''}
                                  </span>
                                </span>
                              </button>
                            );
                          })
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="mt-2.5 flex items-end gap-3">
                  <div className="flex-1">
                    <Textarea
                      data-testid="desktop-chat-input"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey && !taskInputLocked) {
                          event.preventDefault();
                          void handleSend();
                        }
                      }}
                      rows={3}
                      placeholder={
                        !serviceRunning
                          ? branding.startFirstPlaceholder
                          : !transportReady
                            ? branding.waitingRuntimePlaceholder
                            : taskState === 'awaiting_input'
                              ? 'Agent 正在等待你的回复，可直接继续输入。'
                              : taskInputLocked
                                ? '任务正在运行，点击停止可中断当前执行。'
                                : branding.sendPlaceholder
                      }
                      disabled={!serviceRunning || !transportReady || sending || !selectedProject || taskInputLocked}
                      className="min-h-[94px] rounded-[20px] border-slate-200 bg-white px-4 py-3 text-[15px] leading-6 text-slate-900 placeholder:text-slate-400 dark:border-white/[0.08] dark:bg-[#090d12] dark:text-white dark:placeholder:text-slate-500"
                    />
                    <div className="mt-1.5 flex items-center justify-between px-1 text-[11px] text-slate-500 dark:text-slate-400">
                      <span>Enter 发送，Shift + Enter 换行</span>
                      <span>{selectedProject ? '范围会随当前线程保存' : '请先选择项目'}</span>
                    </div>
                  </div>

                  {taskState === 'awaiting_permission' && permissionPromptMessage ? (
                    <div className="flex min-w-[220px] flex-col gap-2 rounded-[20px] border border-amber-200 bg-amber-50/80 p-3 dark:border-amber-400/20 dark:bg-amber-500/10">
                      <p className="text-xs font-medium text-amber-800 dark:text-amber-100">请选择权限响应</p>
                      {visiblePermissionActions.map((row, rowIndex) => (
                        <div key={`${permissionPromptMessage.id}-permission-row-${rowIndex}`} className="flex flex-wrap gap-2">
                          {row.map((action) => (
                            <Button
                              key={`${permissionPromptMessage.id}-${rowIndex}-${action.data}`}
                              size="sm"
                              variant="secondary"
                              onClick={() => void handleBridgeAction(permissionPromptMessage, action)}
                              disabled={Boolean(permissionPromptMessage.actionPending || pendingBridgeActionId)}
                              loading={pendingBridgeActionId === permissionPromptMessage.id}
                              className="rounded-full border border-amber-300 bg-white text-amber-900 hover:bg-amber-100 dark:border-amber-400/30 dark:bg-white/[0.08] dark:text-amber-50 dark:hover:bg-white/[0.12]"
                            >
                              {action.text || action.data}
                            </Button>
                          ))}
                        </div>
                      ))}
                    </div>
                  ) : taskRunning ? (
                    <Button
                      variant="danger"
                      onClick={() => void handleStopTask()}
                      disabled={(!activeSessionKey && !activeRunId) || taskState === 'stopping'}
                      data-testid="desktop-chat-stop-task"
                      className="h-14 min-w-[124px] rounded-[20px] bg-red-50 px-5 text-red-600 hover:bg-red-100 dark:bg-red-500/12 dark:text-red-200 dark:hover:bg-red-500/18"
                    >
                      <LoaderCircle size={16} className="animate-spin" />
                      {taskState === 'stopping' ? '停止中' : '停止任务'}
                    </Button>
                  ) : (
                    <Button
                      onClick={() => void handleSend()}
                      disabled={!draft.trim() || !serviceRunning || !transportReady || sending || !selectedProject}
                      data-testid="desktop-chat-send"
                      className="h-14 w-14 rounded-full px-0 shadow-none"
                    >
                      <Send size={18} />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <Modal open={Boolean(renameTarget)} onClose={() => setRenameTarget(null)} title="重命名会话">
        <div className="space-y-4">
          <Input
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            onInput={(event) => setRenameDraft((event.target as HTMLInputElement).value)}
            placeholder="输入会话名称"
            data-testid="desktop-chat-rename-input"
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRenameTarget(null)} data-testid="desktop-chat-rename-cancel">
              取消
            </Button>
            <Button
              onClick={() => void handleRenameSession()}
              loading={pendingSessionAction === 'rename'}
              disabled={!renameDraft.trim()}
              data-testid="desktop-chat-rename-save"
            >
              保存名称
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} title="删除会话">
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            确定删除 <span className="font-medium text-gray-900 dark:text-white">{deleteTarget?.name}</span> 吗？这会移除该会话的本地保存记录。
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleteTarget(null)} data-testid="desktop-chat-delete-cancel">
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => void handleDeleteSession()}
              loading={pendingSessionAction === 'delete'}
              data-testid="desktop-chat-delete-confirm"
            >
              删除会话
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
