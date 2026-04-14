import {
  Bot,
  Circle,
  LoaderCircle,
  MessageSquarePlus,
  Pencil,
  RotateCw,
  Search,
  Send,
  Trash2,
  User,
  WifiOff,
} from 'lucide-react';
import { Button, Card, EmptyState, Input, Modal, Textarea } from '@/components/ui';
import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { startDesktopService } from '@/api/desktop';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/session-utils';
import { formatMessageTimestamp, formatRuntimePhase } from './thread-chat-model';
import { useThreadChatController } from './useThreadChatController';

export default function ThreadChat() {
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
    taskRunning,
    taskState,
    transportReady,
  } = useThreadChatController();

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-400 animate-pulse">Loading...</div>;
  }

  const selectedKnowledgeBases = selectedKnowledgeBaseIds
    .map((knowledgeBaseId) => availableKnowledgeBases.find((base) => base.id === knowledgeBaseId))
    .filter((base): base is NonNullable<typeof availableKnowledgeBases[number]> => Boolean(base));

  return (
    <>
      <div className="grid grid-cols-[360px_minmax(0,1fr)] gap-6 h-[calc(100vh-8rem)] animate-fade-in">
        <Card className="overflow-hidden p-0 flex flex-col">
          <div className="p-5 border-b border-gray-200/80 dark:border-white/[0.08] space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{branding.chatHeading}</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {branding.chatDescription}
                </p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => void refreshRuntime()}>
                <RotateCw size={14} />
              </Button>
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{branding.scopeLabel}</label>
              <select
                value={selectedProject}
                onChange={(event) => setSelectedProject(event.target.value)}
                data-testid="desktop-chat-project-select"
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300/90 dark:border-white/[0.1] bg-white/90 dark:bg-[rgba(0,0,0,0.45)] text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent/45 focus:border-accent"
              >
                <option value="">{branding.scopeSelectPlaceholder}</option>
                {projects.map((project) => (
                  <option key={project} value={project}>
                    {project}
                  </option>
                ))}
              </select>
            </div>

            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input
                value={sessionSearch}
                onChange={(event) => setSessionSearch(event.target.value)}
                placeholder={branding.searchPlaceholder}
                data-testid="desktop-chat-session-search"
                className="pl-9"
              />
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => void startDesktopService().then(refreshRuntime)}
                disabled={runtime?.phase === 'starting' || serviceRunning}
                data-testid="desktop-chat-start-service"
              >
                {serviceRunning ? formatRuntimePhase(runtime?.phase) : runtime?.phase === 'starting' ? branding.startingRuntimeLabel : branding.startRuntimeLabel}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void handleCreateNew()} data-testid="desktop-chat-new-chat">
                <MessageSquarePlus size={14} /> {branding.newThreadLabel}
              </Button>
            </div>

            {runtime?.service.lastError && (
              <div className="text-xs rounded-lg border border-red-200 bg-red-50 text-red-600 px-3 py-2 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
                {runtime.service.lastError}
              </div>
            )}
            {runtime?.pendingRestart && (
              <div className="text-xs rounded-lg border border-amber-200 bg-amber-50 text-amber-700 px-3 py-2 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
                {branding.pendingRestartLabel}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-4">
            {!selectedProject && filteredSessionGroups.length === 0 ? (
              <EmptyState message={branding.emptySelectionLabel} />
            ) : filteredSessionGroups.length === 0 ? (
              <EmptyState message={branding.emptySearchLabel} />
            ) : (
              filteredSessionGroups.map((group) => (
                <section key={group.project} className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setSelectedProject(group.project)}
                    data-testid="desktop-chat-session-group"
                    data-project={group.project}
                    className={cn(
                      'w-full flex items-center justify-between rounded-xl px-3 py-2 text-left transition-colors',
                      group.project === selectedProject
                        ? 'bg-accent/10 text-gray-900 dark:text-white'
                        : 'bg-gray-100/60 dark:bg-white/[0.04] text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.08]',
                    )}
                  >
                    <div>
                      <p className="text-sm font-medium">{group.project}</p>
                      <p className="text-[10px] uppercase tracking-wide opacity-70">{group.sessions.length} {branding.collectionLabel}</p>
                    </div>
                    {group.project === selectedProject && (
                      <span className="text-[10px] uppercase tracking-wide text-accent">{branding.activeScopeLabel}</span>
                    )}
                  </button>

                  {group.sessions.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-gray-200/80 dark:border-white/[0.08] px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                      {branding.emptyThreadsLabel}
                    </div>
                  ) : (
                    group.sessions.map((session) => (
                      <div
                        key={session.id}
                        data-testid="desktop-chat-session-row"
                        data-session-id={session.id}
                        data-project={group.project}
                        className={cn(
                          'group rounded-xl border px-4 py-3 transition-colors',
                          session.id === activeSessionId
                            ? 'border-accent/40 bg-accent/10'
                            : 'border-transparent bg-gray-100/70 dark:bg-white/[0.04] hover:bg-gray-100 dark:hover:bg-white/[0.08]',
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <button
                            type="button"
                            onClick={() => void loadActiveSession(group.project, session.id)}
                            data-testid="desktop-chat-session-open"
                            data-session-id={session.id}
                            data-project={group.project}
                            className="min-w-0 flex-1 text-left"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <span className="font-medium text-sm text-gray-900 dark:text-white truncate block">
                                  {session.name}
                                </span>
                                <p className="text-[10px] text-gray-400 mt-1">
                                  {timeAgo(session.updatedAt || session.createdAt)}
                                </p>
                              </div>
                              {session.live ? (
                                <span className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400 shrink-0">
                                  <Circle size={6} className="fill-current" /> live
                                </span>
                              ) : (
                                <span className="text-[10px] text-gray-400 shrink-0">offline</span>
                              )}
                            </div>
                            {session.excerpt && (
                              <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-2 line-clamp-2">
                                {session.excerpt.replace(/\n/g, ' ')}
                              </p>
                            )}
                            {showSessionKey && session.bridgeSessionKey && (
                              <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-1">
                                {session.bridgeSessionKey}
                              </p>
                            )}
                          </button>

                          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => openRenameModal(group.project, session)}
                              data-testid="desktop-chat-session-rename"
                              data-session-id={session.id}
                              data-project={group.project}
                            >
                              <Pencil size={14} />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-red-500 hover:text-red-600"
                              data-testid="desktop-chat-session-delete"
                              data-session-id={session.id}
                              data-project={group.project}
                              onClick={() =>
                                setDeleteTarget({
                                  project: group.project,
                                  id: session.id,
                                  name: session.name,
                                })
                              }
                            >
                              <Trash2 size={14} />
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </section>
              ))
            )}
          </div>
        </Card>

        <Card className="flex flex-col min-h-0">
          <div className="pb-4 border-b border-gray-200/80 dark:border-white/[0.08]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2
                  className="text-lg font-semibold text-gray-900 dark:text-white"
                  data-testid="desktop-chat-active-title"
                >
                  {activeSessionName || branding.activeConversationFallback}
                </h2>
                <div className="flex items-center gap-2 mt-1 text-xs text-gray-500 dark:text-gray-400 flex-wrap">
                  {selectedProject ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-white/[0.06] px-2 py-0.5">
                      {selectedProject}
                    </span>
                  ) : (
                    <span>{branding.startConversationLabel}</span>
                  )}
                  {showSessionKey && activeSessionKey ? <span>{activeSessionKey}</span> : null}
                  <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-white/[0.06] px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-300">
                    {formatRuntimePhase(runtime?.phase)}
                  </span>
                  {transportReady ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <Circle size={6} className="fill-current" /> {branding.runtimeOnlineLabel}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <WifiOff size={12} /> {branding.runtimeOfflineLabel}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-4 rounded-xl border border-gray-200/80 dark:border-white/[0.08] bg-gray-50/70 dark:bg-white/[0.03] px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-white">Knowledge bases</p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400">
                    {selectedProject
                      ? 'Select one or more knowledge bases for this thread.'
                      : 'Choose a project first to enable knowledge-base selection.'}
                  </p>
                </div>
                <span className="text-[11px] text-gray-500 dark:text-gray-400">
                  {selectedKnowledgeBaseIds.length} selected
                </span>
              </div>
              <select
                multiple
                value={selectedKnowledgeBaseIds}
                disabled={!selectedProject || availableKnowledgeBases.length === 0}
                onChange={(event) =>
                  void setSelectedKnowledgeBaseIds(Array.from(event.target.selectedOptions, (option) => option.value))
                }
                data-testid="desktop-chat-knowledge-base-select"
                className="mt-3 min-h-28 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-accent dark:border-white/[0.08] dark:bg-[rgba(0,0,0,0.35)] dark:text-white"
              >
                {availableKnowledgeBases.length === 0 ? (
                  <option value="" disabled>
                    No knowledge bases available
                  </option>
                ) : (
                  availableKnowledgeBases.map((base) => (
                    <option key={base.id} value={base.id}>
                      {base.name}
                    </option>
                  ))
                )}
              </select>
              {selectedKnowledgeBases.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {selectedKnowledgeBases.map((base) => (
                    <span
                      key={base.id}
                      className="inline-flex items-center gap-2 rounded-full bg-accent/10 px-3 py-1 text-xs text-gray-700 dark:text-gray-200"
                    >
                      {base.name}
                      <button
                        type="button"
                        onClick={() => void setSelectedKnowledgeBaseIds(selectedKnowledgeBaseIds.filter((id) => id !== base.id))}
                        className="text-gray-500 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
                        data-testid="desktop-chat-knowledge-base-remove"
                      >
                        x
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto py-6 space-y-5">
            {renderedMessages.length === 0 ? (
              <p className="text-center text-sm text-gray-400 py-12">
                {branding.emptyConversationLabel}
              </p>
            ) : (
              renderedMessages.map((message) => {
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
                      data-order={String(message.order)}
                      data-timestamp={message.timestamp || ''}
                      className={cn(
                        'rounded-2xl px-5 py-3.5 text-sm',
                        isUser
                          ? 'max-w-[70%] bg-accent text-black rounded-br-md'
                          : message.kind === 'progress'
                            ? 'max-w-[85%] bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/40 text-amber-900 dark:text-amber-100 rounded-bl-md shadow-sm'
                            : 'max-w-[85%] bg-white dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700/60 text-gray-900 dark:text-gray-100 rounded-bl-md shadow-sm',
                      )}
                    >
                      <div className={cn('mb-2 flex items-center gap-2 text-[10px]', isUser ? 'justify-end text-black/70' : 'text-gray-400 dark:text-gray-500')}>
                        {!isUser && message.kind === 'progress' && (
                          <span className="uppercase tracking-wide text-amber-600 dark:text-amber-300">
                            process
                          </span>
                        )}
                        {formatMessageTimestamp(message.timestamp) && (
                          <span data-testid="desktop-chat-message-timestamp">{formatMessageTimestamp(message.timestamp)}</span>
                        )}
                      </div>
                      <ChatMarkdown content={message.content} isUser={isUser} />
                      {!isUser && message.actions && message.actions.length > 0 && (
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
                                >
                                  {action.text || action.data}
                                </Button>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                      {!isUser && message.actionStatus && (
                        <p
                          className={cn(
                            'mt-3 text-xs',
                            message.actionInteractive
                              ? 'text-gray-500 dark:text-gray-400'
                              : 'text-amber-700 dark:text-amber-200',
                          )}
                          data-testid="desktop-chat-action-status"
                        >
                          {message.actionStatus}
                        </p>
                      )}
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

            {taskHint && (
              <div className="flex items-center gap-2 text-sm text-gray-400" data-testid="desktop-chat-task-hint">
                <Circle size={8} className="fill-current animate-pulse" /> {taskHint}
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
              <Textarea
                data-testid="desktop-chat-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !taskRunning) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                rows={4}
                placeholder={!serviceRunning ? branding.startFirstPlaceholder : !transportReady ? branding.waitingRuntimePlaceholder : taskRunning ? 'Task is running. Click stop to interrupt.' : branding.sendPlaceholder}
                disabled={!serviceRunning || !transportReady || sending || !selectedProject || taskRunning}
                className="min-h-[112px] resize-none"
              />
              {taskRunning ? (
                <Button
                  variant="danger"
                  onClick={() => void handleStopTask()}
                  disabled={(!activeSessionKey && !activeRunId) || taskState === 'stopping'}
                  data-testid="desktop-chat-stop-task"
                  className="min-w-[112px]"
                >
                  {taskState === 'stopping' ? (
                    <>
                      <LoaderCircle size={16} className="animate-spin" /> Stopping…
                    </>
                  ) : (
                    <>
                      <LoaderCircle size={16} className="animate-spin" /> Stop task
                    </>
                  )}
                </Button>
              ) : (
                <Button
                  onClick={() => void handleSend()}
                  disabled={!draft.trim() || !serviceRunning || !transportReady || sending || !selectedProject}
                  data-testid="desktop-chat-send"
                  className="min-w-[48px]"
                >
                  <Send size={16} />
                </Button>
              )}
            </div>
          </div>
        </Card>
      </div>

      <Modal open={Boolean(renameTarget)} onClose={() => setRenameTarget(null)} title="Rename session">
        <div className="space-y-4">
          <Input
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            onInput={(event) => setRenameDraft((event.target as HTMLInputElement).value)}
            placeholder="Session name"
            data-testid="desktop-chat-rename-input"
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRenameTarget(null)} data-testid="desktop-chat-rename-cancel">
              Cancel
            </Button>
            <Button
              onClick={() => void handleRenameSession()}
              loading={pendingSessionAction === 'rename'}
              disabled={!renameDraft.trim()}
              data-testid="desktop-chat-rename-save"
            >
              Save name
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} title="Delete session">
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Delete <span className="font-medium text-gray-900 dark:text-white">{deleteTarget?.name}</span>? This removes the
            saved conversation history for that session.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleteTarget(null)} data-testid="desktop-chat-delete-cancel">
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => void handleDeleteSession()}
              loading={pendingSessionAction === 'delete'}
              data-testid="desktop-chat-delete-confirm"
            >
              Delete session
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
