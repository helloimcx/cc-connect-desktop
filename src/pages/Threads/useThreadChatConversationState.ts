import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { getThread } from '../../../packages/core-sdk/src';
import type { ThreadDetail } from '../../../packages/contracts/src';
import {
  ASSISTANT_REPLY_TIMEOUT_MS,
  formatTaskHint,
  isTaskInputLocked,
  isTaskRunningState,
  sortChatMessages,
  toCoreChatThreadSummary,
  toMessagesFromThread,
  upsertThreadInGroup,
  type ChatMessage,
  type ChatTaskState,
  type ThreadGroup,
} from './thread-chat-model';

function advancePreviewContent(content: string, target: string) {
  if (!target) {
    return '';
  }
  if (!content || !target.startsWith(content)) {
    return target.slice(0, Math.min(target.length, Math.max(1, Math.ceil(target.length / 24))));
  }
  if (content === target) {
    return target;
  }
  const remaining = target.length - content.length;
  const step = remaining > 160 ? 14 : remaining > 80 ? 8 : remaining > 24 ? 4 : 2;
  return target.slice(0, Math.min(target.length, content.length + step));
}

type UseThreadChatConversationStateInput = {
  activeThreadId: string;
  brandingReplyTimeoutLabel: string;
  setSelectedKnowledgeBaseIds: Dispatch<SetStateAction<string[]>>;
  setActiveRunId: Dispatch<SetStateAction<string>>;
  setActiveSessionAgentType: Dispatch<SetStateAction<string>>;
  setActiveSessionId: Dispatch<SetStateAction<string>>;
  setActiveSessionKey: Dispatch<SetStateAction<string>>;
  setActiveSessionName: Dispatch<SetStateAction<string>>;
  setBridgeError: Dispatch<SetStateAction<string>>;
  setSelectedProject: Dispatch<SetStateAction<string>>;
  setThreadGroups: Dispatch<SetStateAction<ThreadGroup[]>>;
};

export function useThreadChatConversationState({
  activeThreadId,
  brandingReplyTimeoutLabel,
  setSelectedKnowledgeBaseIds,
  setActiveRunId,
  setActiveSessionAgentType,
  setActiveSessionId,
  setActiveSessionKey,
  setActiveSessionName,
  setBridgeError,
  setSelectedProject,
  setThreadGroups,
}: UseThreadChatConversationStateInput) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [typing, setTyping] = useState(false);
  const [taskState, setTaskState] = useState<ChatTaskState>('idle');
  const replyTimeoutRef = useRef<number | null>(null);
  const replyTimeoutModeRef = useRef<'reply' | 'permission_continue'>('reply');
  const lastSessionByProjectRef = useRef<Record<string, string>>({});
  const nextMessageOrderRef = useRef(0);
  const pendingTurnRef = useRef<{ sessionKey: string; userOrder: number } | null>(null);
  const holdBlankComposerRef = useRef(false);
  const progressSequenceByTurnRef = useRef<Record<string, number>>({});
  const taskStateRef = useRef<ChatTaskState>('idle');
  const activeThreadIdRef = useRef('');
  const localCorePollGenerationRef = useRef(0);

  const renderedMessages = useMemo(() => sortChatMessages(messages), [messages]);
  const taskRunning = isTaskRunningState(taskState);
  const taskInputLocked = isTaskInputLocked(taskState);
  const taskHint = formatTaskHint(taskState, typing);

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  const updateTaskState = useCallback((next: ChatTaskState, reason = 'unspecified') => {
    const previous = taskStateRef.current;
    taskStateRef.current = next;
    setTaskState(next);
    if (previous !== next) {
      console.info('[desktop-chat] task_state', {
        from: previous,
        to: next,
        reason,
        threadId: activeThreadIdRef.current,
      });
    }
  }, []);

  const clearReplyTimeout = useCallback(() => {
    if (replyTimeoutRef.current) {
      window.clearTimeout(replyTimeoutRef.current);
      replyTimeoutRef.current = null;
    }
  }, []);

  const armReplyTimeout = useCallback((mode: 'reply' | 'permission_continue' = 'reply') => {
    clearReplyTimeout();
    replyTimeoutModeRef.current = mode;
    replyTimeoutRef.current = window.setTimeout(() => {
      setTyping(false);
      pendingTurnRef.current = null;
      updateTaskState('idle', 'reply-timeout');
      setBridgeError(
        mode === 'permission_continue'
          ? brandingReplyTimeoutLabel
          : 'Agent did not respond in time. Check AI-WorkStation runtime logs or adjust the model/provider.',
      );
    }, ASSISTANT_REPLY_TIMEOUT_MS);
  }, [brandingReplyTimeoutLabel, clearReplyTimeout, setBridgeError, updateTaskState]);

  const clearActionStatuses = useCallback(() => {
    setMessages((current) =>
      current.map((message) =>
        message.actionStatus || message.actionPending
          ? { ...message, actionPending: false, actionStatus: undefined }
          : message,
      ),
    );
  }, []);

  const settlePreviewMessages = useCallback((turnKey?: string) => {
    setMessages((current) => {
      let changed = false;
      const next = current.map((message) => {
        if (!message.preview) {
          return message;
        }
        if (turnKey && message.turnKey !== turnKey) {
          return message;
        }
        changed = true;
        return {
          ...message,
          content: message.streamTargetContent ?? message.content,
          streamTargetContent: undefined,
          preview: false,
          previewPlainText: false,
        };
      });
      return changed ? next : current;
    });
  }, []);

  const reserveNextMessageOrder = useCallback(() => {
    const order = nextMessageOrderRef.current;
    nextMessageOrderRef.current += 1;
    return order;
  }, []);

  const reserveAssistantMessageOrder = useCallback((sessionKey?: string) => {
    const pendingTurn = pendingTurnRef.current;
    if (pendingTurn && sessionKey && pendingTurn.sessionKey === sessionKey) {
      const minimum = pendingTurn.userOrder + 1;
      if (nextMessageOrderRef.current < minimum) {
        nextMessageOrderRef.current = minimum;
      }
    }
    return reserveNextMessageOrder();
  }, [reserveNextMessageOrder]);

  const nextProgressMessageId = useCallback((replyCtx?: string) => {
    const turnKey = replyCtx || crypto.randomUUID();
    const nextSequence = (progressSequenceByTurnRef.current[turnKey] || 0) + 1;
    progressSequenceByTurnRef.current[turnKey] = nextSequence;
    return `${turnKey}-progress-${nextSequence}`;
  }, []);

  const finalizeTurnMessages = useCallback((turnKey?: string) => {
    if (!turnKey) {
      return;
    }
    setMessages((current) => {
      const candidates = current.filter((message) => message.turnKey === turnKey && !message.preview);
      if (candidates.length === 0) {
        return current;
      }
      const lastId = candidates[candidates.length - 1]?.id;
      return current.map((message) => {
        if (message.turnKey !== turnKey || message.preview) {
          return message;
        }
        return {
          ...message,
          kind: message.id === lastId ? 'final' : 'progress',
        };
      });
    });
  }, []);

  const clearLocalCorePolling = useCallback(() => {
    localCorePollGenerationRef.current += 1;
  }, []);

  const applyLocalCoreThreadDetail = useCallback((detail: ThreadDetail) => {
    lastSessionByProjectRef.current[detail.workspaceId] = detail.id;
    setSelectedProject(detail.workspaceId);
    setActiveSessionId(detail.id);
    setActiveSessionKey(detail.bridgeSessionKey || '');
    setActiveSessionName(detail.title);
    setActiveSessionAgentType(detail.agentType || '');
    setActiveRunId(detail.runId || '');
    setSelectedKnowledgeBaseIds(detail.selectedKnowledgeBaseIds || []);
    setThreadGroups((current) => upsertThreadInGroup(current, detail.workspaceId, toCoreChatThreadSummary(detail)));
    holdBlankComposerRef.current = false;
    progressSequenceByTurnRef.current = {};
    const nextMessages = toMessagesFromThread(detail.messages || []);
    nextMessageOrderRef.current = nextMessages.length;
    pendingTurnRef.current = null;
    setMessages(nextMessages);
  }, [
    setActiveRunId,
    setActiveSessionAgentType,
    setActiveSessionId,
    setActiveSessionKey,
    setActiveSessionName,
    setSelectedKnowledgeBaseIds,
    setSelectedProject,
    setThreadGroups,
  ]);

  const startLocalCoreThreadPolling = useCallback((threadId: string, baselineAssistantCount: number) => {
    clearLocalCorePolling();
    const generation = localCorePollGenerationRef.current;
    const startedAt = Date.now();
    let unchangedPolls = 0;
    let lastSignature = '';

    const tick = async () => {
      if (localCorePollGenerationRef.current !== generation || activeThreadIdRef.current !== threadId) {
        return;
      }
      try {
        const detail = await getThread(threadId);
        if (localCorePollGenerationRef.current !== generation || activeThreadIdRef.current !== threadId) {
          return;
        }
        applyLocalCoreThreadDetail(detail);
        const nextMessages = toMessagesFromThread(detail.messages || []);
        const assistantCount = nextMessages.filter((message) => message.role === 'assistant').length;
        const signature = nextMessages.map((message) => `${message.id}:${message.content}:${message.kind || 'final'}`).join('|');
        unchangedPolls = signature === lastSignature ? unchangedPolls + 1 : 0;
        lastSignature = signature;
        if ((assistantCount > baselineAssistantCount && unchangedPolls >= 2) || Date.now() - startedAt >= ASSISTANT_REPLY_TIMEOUT_MS) {
          setTyping(false);
          updateTaskState('idle', 'local-core-poll-complete');
          if (Date.now() - startedAt >= ASSISTANT_REPLY_TIMEOUT_MS && assistantCount <= baselineAssistantCount) {
            setBridgeError('Agent did not respond in time. Check Local AI Core logs or adapter status.');
          }
          return;
        }
        window.setTimeout(() => {
          void tick();
        }, 1500);
      } catch (error) {
        if (localCorePollGenerationRef.current !== generation || activeThreadIdRef.current !== threadId) {
          return;
        }
        setTyping(false);
        updateTaskState('error', 'local-core-poll-error');
        setBridgeError(error instanceof Error ? error.message : 'Failed to refresh the current thread.');
      }
    };

    window.setTimeout(() => {
      void tick();
    }, 1500);
  }, [applyLocalCoreThreadDetail, clearLocalCorePolling, setBridgeError, updateTaskState]);

  useEffect(() => {
    const hasPendingPreview = messages.some((message) =>
      message.preview &&
      message.previewPlainText &&
      typeof message.streamTargetContent === 'string' &&
      message.streamTargetContent !== message.content,
    );
    if (!hasPendingPreview) {
      return;
    }
    const timer = window.setInterval(() => {
      setMessages((current) => {
        let changed = false;
        const next = current.map((message) => {
          if (
            !message.preview ||
            !message.previewPlainText ||
            typeof message.streamTargetContent !== 'string' ||
            message.streamTargetContent === message.content
          ) {
            return message;
          }
          changed = true;
          return {
            ...message,
            content: advancePreviewContent(message.content, message.streamTargetContent),
          };
        });
        return changed ? next : current;
      });
    }, 32);
    return () => {
      window.clearInterval(timer);
    };
  }, [messages]);

  return {
    applyLocalCoreThreadDetail,
    armReplyTimeout,
    clearActionStatuses,
    clearLocalCorePolling,
    clearReplyTimeout,
    holdBlankComposerRef,
    lastSessionByProjectRef,
    messages,
    nextMessageOrderRef,
    finalizeTurnMessages,
    nextProgressMessageId,
    pendingTurnRef,
    progressSequenceByTurnRef,
    renderedMessages,
    reserveAssistantMessageOrder,
    reserveNextMessageOrder,
    setMessages,
    settlePreviewMessages,
    setTyping,
    startLocalCoreThreadPolling,
    taskHint,
    taskInputLocked,
    taskRunning,
    taskState,
    taskStateRef,
    typing,
    updateTaskState,
  };
}
