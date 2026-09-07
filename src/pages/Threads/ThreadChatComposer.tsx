import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  Database,
  LoaderCircle,
  Shield,
  X,
} from 'lucide-react';
import { Button, Input, Textarea } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useRuntimeFeatureSupport } from '@/app/runtime';
import { PermissionRequestCardView } from './ThreadChatMessage';
import {
  canSubmitComposer,
  filterKnowledgeBases,
  getComposerPlaceholder,
  orderKnowledgeBases,
  toComposerPermissionCard,
  toSelectedKnowledgeBases,
} from './thread-chat-page-state';
import type { SelectedKnowledgeBaseSummary } from './thread-chat-page-state';
import type { PermissionCard } from './thread-chat-message-blocks';
import type { ChatTaskState } from './thread-chat-model';

type KnowledgeBase = Parameters<typeof filterKnowledgeBases>[0][number];

const PERMISSION_MODE_OPTIONS = [
  { value: 'default', label: '请求批准', tone: 'safe' },
  { value: 'bypassPermissions', label: '完全访问', tone: 'open' },
] as const;

interface ThreadChatComposerProps {
  activeRunId: string;
  activeAgentMode: string;
  activeSessionKey: string;
  availableKnowledgeBases: KnowledgeBase[];
  branding: {
    startFirstPlaceholder: string;
    waitingRuntimePlaceholder: string;
    sendPlaceholder: string;
  };
  composerPermissionCard: ReturnType<typeof toComposerPermissionCard>;
  draft: string;
  pendingBridgeActionId: string | null;
  permissionModeSaving: boolean;
  selectedKnowledgeBaseIds: string[];
  selectedProject: string;
  sending: boolean;
  serviceRunning: boolean;
  taskInputLocked: boolean;
  taskRunning: boolean;
  taskState: ChatTaskState;
  transportReady: boolean;
  onBridgeAction: (message: PermissionCard, action: PermissionCard['actions'][number][number]) => void;
  onSend: () => void;
  onStopTask: () => void;
  setActiveAgentMode: (mode: string) => void;
  setDraft: (draft: string) => void;
  setSelectedKnowledgeBaseIds: (ids: string[]) => void;
}

export function ThreadChatComposer({
  activeRunId,
  activeAgentMode,
  activeSessionKey,
  availableKnowledgeBases,
  branding,
  composerPermissionCard,
  draft,
  pendingBridgeActionId,
  permissionModeSaving,
  selectedKnowledgeBaseIds,
  selectedProject,
  sending,
  serviceRunning,
  taskInputLocked,
  taskRunning,
  taskState,
  transportReady,
  onBridgeAction,
  onSend,
  onStopTask,
  setActiveAgentMode,
  setDraft,
  setSelectedKnowledgeBaseIds,
}: ThreadChatComposerProps) {
  const { knowledgeModule } = useRuntimeFeatureSupport();
  const [knowledgePickerOpen, setKnowledgePickerOpen] = useState(false);
  const knowledgePickerRef = useRef<HTMLDivElement>(null);
  const [knowledgeSearch, setKnowledgeSearch] = useState('');

  const selectedKnowledgeBases: SelectedKnowledgeBaseSummary[] = toSelectedKnowledgeBases(
    selectedKnowledgeBaseIds,
    availableKnowledgeBases,
  );

  const filteredKnowledgeBases = filterKnowledgeBases(availableKnowledgeBases, knowledgeSearch);
  const orderedKnowledgeBases = orderKnowledgeBases(filteredKnowledgeBases, selectedKnowledgeBaseIds);
  const selectedKnowledgeCount = selectedKnowledgeBaseIds.length;
  const normalizedAgentMode = PERMISSION_MODE_OPTIONS.some((option) => option.value === activeAgentMode)
    ? activeAgentMode
    : 'default';

  const composerPlaceholder = getComposerPlaceholder({
    serviceRunning,
    transportReady,
    taskState,
    taskInputLocked,
    startFirstPlaceholder: branding.startFirstPlaceholder,
    waitingRuntimePlaceholder: branding.waitingRuntimePlaceholder,
    sendPlaceholder: branding.sendPlaceholder,
  });

  const composerCanSubmit = canSubmitComposer({
    draft,
    serviceRunning,
    transportReady,
    sending,
    selectedProject,
  });

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

  return (
    <div className="border-t border-slate-200/80 px-3 py-3 dark:border-white/[0.06] sm:px-6">
      <div className="mx-auto max-w-4xl rounded-[24px] border border-slate-200 bg-[#fbfbfd] p-2 dark:border-white/[0.08] dark:bg-[#111214] sm:p-2.5">
        {composerPermissionCard ? (
          <PermissionRequestCardView
            card={composerPermissionCard}
            loading={pendingBridgeActionId === composerPermissionCard.id}
            onAction={(action) => void onBridgeAction(composerPermissionCard, action)}
            testId="desktop-chat-composer-permission-card"
            className="border-primary/45 bg-white shadow-[0_14px_34px_rgba(0,122,255,0.12)] dark:border-primary/35 dark:bg-[#090d12]"
          />
        ) : (
          <>
            <div className="relative">
              <Textarea
                data-testid="desktop-chat-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !taskInputLocked) {
                    event.preventDefault();
                    void onSend();
                  }
                }}
                rows={3}
                placeholder={composerPlaceholder}
                aria-label={composerPlaceholder}
                disabled={!serviceRunning || !transportReady || sending || !selectedProject || taskInputLocked}
                className="min-h-[104px] rounded-[22px] border-slate-200 bg-white px-4 pb-16 pt-3 text-[15px] leading-6 text-slate-900 placeholder:text-slate-400 focus-visible:ring-primary/15 dark:border-white/[0.08] dark:bg-[#090d12] dark:text-white dark:placeholder:text-slate-500 sm:min-h-[116px] sm:px-5 sm:pt-4"
              />

              {taskRunning ? (
                <Button
                  variant="danger"
                  onClick={() => void onStopTask()}
                  disabled={(!activeSessionKey && !activeRunId) || taskState === 'stopping'}
                  data-testid="desktop-chat-stop-task"
                  className="absolute bottom-3 right-3 h-11 min-w-11 rounded-full bg-red-50 px-3 text-red-600 shadow-none hover:bg-red-100 dark:bg-red-500/12 dark:text-red-200 dark:hover:bg-red-500/18 sm:h-12 sm:min-w-[118px] sm:px-5"
                >
                  <LoaderCircle size={16} className="animate-spin" />
                  <span className="hidden sm:inline">{taskState === 'stopping' ? '停止中' : '停止任务'}</span>
                </Button>
              ) : (
                <Button
                  onClick={() => void onSend()}
                  disabled={!composerCanSubmit}
                  data-testid="desktop-chat-send"
                  className="absolute bottom-3 right-3 h-11 w-11 rounded-full bg-primary px-0 text-white shadow-none hover:bg-[#0071e3] disabled:bg-slate-300 disabled:text-white disabled:opacity-100 dark:bg-primary dark:text-white dark:hover:bg-[#2997ff] dark:disabled:bg-white/20 dark:disabled:text-white/55 sm:h-12 sm:w-12"
                >
                  {sending ? <LoaderCircle size={18} className="animate-spin" /> : <ArrowUp size={22} strokeWidth={2.2} />}
                </Button>
              )}
            </div>

            <div className="mt-2 flex flex-col gap-2 px-1 pr-0 text-[11px] text-slate-500 dark:text-slate-400 sm:flex-row sm:items-center sm:justify-between sm:pr-[4.5rem]">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <div
                  className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-slate-200 bg-white p-1 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05]"
                  role="group"
                  aria-label="权限模式"
                  data-testid="desktop-chat-permission-mode"
                >
                  <Shield size={13} className="ml-1 text-amber-500" />
                  {PERMISSION_MODE_OPTIONS.map((option) => {
                    const active = normalizedAgentMode === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        disabled={!selectedProject || permissionModeSaving || taskRunning}
                        onClick={() => setActiveAgentMode(option.value)}
                        data-testid={`desktop-chat-permission-mode-${option.value}`}
                        className={cn(
                          'h-6 rounded-full px-2.5 text-xs font-medium transition-colors',
                          active
                            ? option.tone === 'open'
                              ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/18 dark:text-amber-100'
                              : 'bg-slate-900 text-white dark:bg-white dark:text-slate-950'
                            : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/[0.08] dark:hover:text-white',
                          'disabled:cursor-not-allowed disabled:opacity-50',
                        )}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                  {permissionModeSaving ? <LoaderCircle size={12} className="mr-1 animate-spin text-slate-400" /> : null}
                </div>

                {knowledgeModule ? (
                  <>
                    <div className="relative" ref={knowledgePickerRef}>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!selectedProject}
                        onClick={() => setKnowledgePickerOpen((current) => !current)}
                        data-testid="desktop-chat-knowledge-base-toggle"
                        className="h-8 rounded-full border border-slate-200 bg-white px-2.5 text-xs text-slate-700 shadow-sm hover:bg-slate-100 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-slate-100 dark:hover:bg-white/[0.1]"
                      >
                        <Database size={13} />
                        {selectedKnowledgeCount > 0 ? '调整知识库' : '选择知识库'}
                      </Button>

                      {knowledgePickerOpen ? (
                        <div className="animate-float-in absolute bottom-full left-0 z-20 mb-3 w-[min(34rem,calc(100vw-2rem))] max-h-[70dvh] overflow-hidden rounded-[22px] border border-slate-200 bg-white p-3 shadow-[0_18px_45px_rgba(15,23,42,0.12)] dark:border-white/[0.08] dark:bg-[#0c1117]">
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
                            aria-label="搜索知识库"
                            className="mt-3 rounded-[18px] border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white dark:placeholder:text-slate-500"
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
                                      'flex w-full items-start gap-3 rounded-[16px] border px-3 py-3 text-left transition-all duration-200',
                                      checked
                                        ? 'border-primary/25 bg-primary/5 dark:border-primary/30 dark:bg-primary/10'
                                        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-[#fafafa] dark:border-white/[0.06] dark:bg-white/[0.03] dark:hover:border-white/[0.12] dark:hover:bg-white/[0.05]',
                                    )}
                                  >
                                    <span
                                      className={cn(
                                        'mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border text-[10px]',
                                        checked
                                          ? 'border-primary bg-primary text-white'
                                          : 'border-slate-300 text-transparent dark:border-white/[0.12]',
                                      )}
                                    >
                                      <Check size={12} />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate text-sm font-medium text-slate-900 dark:text-white">{base.name}</span>
                                      <span className="mt-1 block text-[11px] text-slate-400">
                                        {base.fileCount} 文件
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

                    <div className="flex min-w-0 items-center gap-2 overflow-x-auto whitespace-nowrap [scrollbar-gutter:stable]">
                      {selectedKnowledgeBases.length === 0 ? (
                        <span className="text-xs text-slate-400">
                          {selectedProject ? '当前未限制知识库范围' : '选择项目后可设置知识库范围'}
                        </span>
                      ) : (
                        selectedKnowledgeBases.map((base) => (
                          <span
                            key={base.id}
                            className="inline-flex shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-slate-100"
                          >
                            <span className="max-w-[10rem] truncate">{base.name}</span>
                            {base.fileCount > 0 ? <span className="text-[10px] text-slate-500">{base.fileCount} 文件</span> : null}
                            <button
                              type="button"
                              onClick={() => void setSelectedKnowledgeBaseIds(selectedKnowledgeBaseIds.filter((id) => id !== base.id))}
                              className="text-slate-500 transition-colors hover:text-slate-900 dark:hover:text-white"
                              data-testid="desktop-chat-knowledge-base-remove"
                              aria-label={`移除 ${base.name}`}
                            >
                              <X size={12} />
                            </button>
                          </span>
                        ))
                      )}
                    </div>
                  </>
                ) : null}
              </div>

              <div className="hidden shrink-0 items-center gap-3 sm:flex">
                <span>Enter 发送，Shift + Enter 换行</span>
                <span>{selectedProject ? '范围会随当前线程保存' : '请先选择项目'}</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
