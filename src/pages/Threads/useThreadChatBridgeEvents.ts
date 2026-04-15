import { useCallback, useEffect } from 'react';
import { onBridgeEvent } from '@/api/desktop';
import { getRuntimeBranding } from '@/lib/runtime-branding';
import {
  supportsInteractivePermission,
  type DesktopBridgeEvent,
} from '../../../shared/desktop';
import {
  isAwaitingInputMessage,
  isInternalProgressMessage,
  isPermissionActionRow,
  normalizeBridgeActionRows,
  sessionProjectFromKey,
  type ChatMessage,
} from './thread-chat-model';
import type {
  ThreadChatActiveThreadIdentity,
  ThreadChatConversationRefs,
  ThreadChatSharedHookContext,
} from './thread-chat-action-types';

function permissionSupportMessage(agentType?: string) {
  const name = agentType || 'This agent';
  const branding = getRuntimeBranding();
  if (branding.permissionUnsupportedLabel.startsWith('This agent')) {
    return branding.permissionUnsupportedLabel;
  }
  return `${name} ${branding.permissionUnsupportedLabel.replace(/^This agent\s+/i, '')}`;
}

type UseThreadChatBridgeEventsInput = {
  messages: ChatMessage[];
  clearActionStatuses: () => void;
  finalizeTurnMessages: (turnKey?: string) => void;
  nextProgressMessageId: (replyCtx?: string) => string;
  reserveAssistantMessageOrder: (sessionKey?: string) => number;
  armReplyTimeout: (mode?: 'reply' | 'permission_continue') => void;
} & Pick<ThreadChatSharedHookContext, 'clearLocalCorePolling' | 'clearReplyTimeout' | 'updateTaskState'> &
  Pick<ThreadChatSharedHookContext, 'refreshThreadsForWorkspace' | 'setBridgeError' | 'setMessages' | 'setTyping'> &
  Pick<ThreadChatActiveThreadIdentity, 'activeBridgeSessionKey' | 'activeAgentType'> &
  Pick<ThreadChatConversationRefs, 'pendingTurnRef' | 'progressSequenceByTurnRef' | 'taskStateRef'>;

export function useThreadChatBridgeEvents({
  activeAgentType,
  activeBridgeSessionKey,
  armReplyTimeout,
  clearActionStatuses,
  clearLocalCorePolling,
  clearReplyTimeout,
  finalizeTurnMessages,
  nextProgressMessageId,
  pendingTurnRef,
  progressSequenceByTurnRef,
  refreshThreadsForWorkspace,
  reserveAssistantMessageOrder,
  setBridgeError,
  setMessages,
  setTyping,
  taskStateRef,
  updateTaskState,
}: UseThreadChatBridgeEventsInput) {
  const handleBridgeEvent = useCallback((event: DesktopBridgeEvent) => {
    const eventWorkspaceId = sessionProjectFromKey(event.sessionKey);
    if (eventWorkspaceId) {
      void refreshThreadsForWorkspace(eventWorkspaceId);
    }

    if (!event.sessionKey || event.sessionKey !== activeBridgeSessionKey) {
      return;
    }

    switch (event.type) {
      case 'preview_start':
        if (isAwaitingInputMessage(event.content)) {
          clearReplyTimeout();
          setTyping(false);
          pendingTurnRef.current = null;
          clearActionStatuses();
          updateTaskState('awaiting_input');
          setBridgeError('');
          setMessages((current) => {
            const previewId = event.previewHandle || crypto.randomUUID();
            const existing = current.find((message) => message.id === previewId);
            const next = current.filter((message) => !(message.preview && message.id === previewId));
            next.push({
              id: previewId,
              role: 'assistant',
              content: event.content || '',
              kind: 'progress',
              order: existing?.order ?? reserveAssistantMessageOrder(event.sessionKey),
              timestamp: existing?.timestamp || new Date().toISOString(),
              turnKey: event.replyCtx,
              preview: true,
            });
            return next;
          });
          break;
        }
        clearActionStatuses();
        setTyping(true);
        if (taskStateRef.current !== 'awaiting_input') {
          updateTaskState('running');
        }
        armReplyTimeout();
        setBridgeError('');
        setMessages((current) => {
          const previewId = event.previewHandle || crypto.randomUUID();
          const existing = current.find((message) => message.id === previewId);
          const next = current.filter((message) => !(message.preview && message.id === previewId));
          next.push({
            id: previewId,
            role: 'assistant',
            content: event.content || '',
            kind: 'progress',
            order: existing?.order ?? reserveAssistantMessageOrder(event.sessionKey),
            timestamp: existing?.timestamp || new Date().toISOString(),
            turnKey: event.replyCtx,
            preview: true,
          });
          return next;
        });
        break;
      case 'update_message':
        if (isAwaitingInputMessage(event.content)) {
          clearReplyTimeout();
          setTyping(false);
          pendingTurnRef.current = null;
          clearActionStatuses();
          updateTaskState('awaiting_input');
          setBridgeError('');
          setMessages((current) =>
            current.some((message) => message.id === event.previewHandle)
              ? current.map((message) =>
                  message.id === event.previewHandle ? { ...message, content: event.content || '' } : message,
                )
              : [
                  ...current,
                  {
                    id: event.previewHandle || crypto.randomUUID(),
                    role: 'assistant',
                    content: event.content || '',
                    kind: 'progress',
                    order: reserveAssistantMessageOrder(event.sessionKey),
                    timestamp: new Date().toISOString(),
                    turnKey: event.replyCtx,
                    preview: true,
                  },
                ],
          );
          break;
        }
        clearActionStatuses();
        setTyping(true);
        if (taskStateRef.current !== 'awaiting_input') {
          updateTaskState('running');
        }
        armReplyTimeout();
        setBridgeError('');
        setMessages((current) =>
          current.some((message) => message.id === event.previewHandle)
            ? current.map((message) =>
                message.id === event.previewHandle ? { ...message, content: event.content || '' } : message,
              )
            : [
                ...current,
                {
                  id: event.previewHandle || crypto.randomUUID(),
                  role: 'assistant',
                  content: event.content || '',
                  kind: 'progress',
                  order: reserveAssistantMessageOrder(event.sessionKey),
                  timestamp: new Date().toISOString(),
                  turnKey: event.replyCtx,
                  preview: true,
                },
              ],
        );
        break;
      case 'delete_message':
        setMessages((current) => current.filter((message) => message.id !== event.previewHandle));
        break;
      case 'typing_start':
        clearActionStatuses();
        setTyping(true);
        if (taskStateRef.current !== 'awaiting_input') {
          updateTaskState('running');
        }
        setBridgeError('');
        armReplyTimeout();
        break;
      case 'typing_stop':
        setTyping(false);
        clearReplyTimeout();
        pendingTurnRef.current = null;
        clearActionStatuses();
        updateTaskState('idle');
        finalizeTurnMessages(event.replyCtx);
        break;
      case 'reply': {
        const awaitingInput = isAwaitingInputMessage(event.content);
        clearActionStatuses();
        setTyping(awaitingInput ? false : true);
        if (awaitingInput) {
          clearReplyTimeout();
          pendingTurnRef.current = null;
          updateTaskState('awaiting_input');
        } else if (taskStateRef.current !== 'awaiting_input') {
          updateTaskState('running');
          armReplyTimeout();
        }
        setBridgeError('');
        const replyMessageId = nextProgressMessageId(event.replyCtx);
        if (!isInternalProgressMessage(event.content) && event.replyCtx) {
          delete progressSequenceByTurnRef.current[event.replyCtx];
        }
        setBridgeError('');
        setMessages((current) => [
          ...current.filter((message) => !(message.preview && message.turnKey === event.replyCtx)),
          {
            id: replyMessageId,
            role: 'assistant',
            content: event.content || '',
            kind: 'progress',
            order: reserveAssistantMessageOrder(event.sessionKey),
            timestamp: new Date().toISOString(),
            turnKey: event.replyCtx,
          },
        ]);
        break;
      }
      case 'buttons':
        clearReplyTimeout();
        setTyping(false);
        pendingTurnRef.current = null;
        setBridgeError('');
        clearActionStatuses();
        setMessages((current) => {
          const messageId = `${event.replyCtx || crypto.randomUUID()}-buttons`;
          const actionRows = normalizeBridgeActionRows(event.buttonRows || event.buttons);
          const isPermissionPrompt = isPermissionActionRow(actionRows);
          const interactivePermission = isPermissionPrompt && supportsInteractivePermission(activeAgentType);
          const nextActions = isPermissionPrompt && !interactivePermission ? [] : actionRows;
          const nextStatus = isPermissionPrompt && !interactivePermission
            ? permissionSupportMessage(activeAgentType)
            : undefined;
          const existing = current.find((message) => message.id === messageId);
          if (existing) {
            return current.map((message) =>
              message.id === messageId
                ? {
                    ...message,
                    content: event.content || message.content,
                    actions: nextActions,
                    actionReplyCtx: event.replyCtx,
                    actionPending: false,
                    actionMode: isPermissionPrompt ? 'permission' : 'generic',
                    actionInteractive: interactivePermission,
                    actionStatus: nextStatus,
                  }
                : message,
            );
          }
          return [
            ...current,
            {
              id: messageId,
              role: 'assistant',
              content: event.content || 'Permission required before continuing.',
              kind: 'progress',
              order: reserveAssistantMessageOrder(event.sessionKey),
              timestamp: new Date().toISOString(),
              turnKey: event.replyCtx,
              actions: nextActions,
              actionReplyCtx: event.replyCtx,
              actionPending: false,
              actionMode: isPermissionPrompt ? 'permission' : 'generic',
              actionInteractive: interactivePermission,
              actionStatus: nextStatus,
            },
          ];
        });
        updateTaskState(
          isPermissionActionRow(normalizeBridgeActionRows(event.buttonRows || event.buttons)) &&
            supportsInteractivePermission(activeAgentType)
            ? 'awaiting_permission'
            : normalizeBridgeActionRows(event.buttonRows || event.buttons).length > 0
              ? 'awaiting_input'
              : 'idle',
        );
        break;
      case 'card':
        clearReplyTimeout();
        setTyping(false);
        pendingTurnRef.current = null;
        clearActionStatuses();
        updateTaskState('idle');
        finalizeTurnMessages(event.replyCtx);
        setBridgeError('');
        setMessages((current) => [
          ...current,
          {
            id: `${event.replyCtx || crypto.randomUUID()}-card`,
            role: 'assistant',
            content: 'Interactive card received. Open the session in the standard Sessions view for full controls.',
            order: reserveAssistantMessageOrder(event.sessionKey),
            timestamp: new Date().toISOString(),
          },
        ]);
        break;
      default:
        break;
    }
  }, [
    activeAgentType,
    activeBridgeSessionKey,
    armReplyTimeout,
    clearActionStatuses,
    clearReplyTimeout,
    finalizeTurnMessages,
    nextProgressMessageId,
    pendingTurnRef,
    progressSequenceByTurnRef,
    refreshThreadsForWorkspace,
    reserveAssistantMessageOrder,
    setBridgeError,
    setMessages,
    setTyping,
    updateTaskState,
  ]);

  useEffect(() => {
    const stopBridge = onBridgeEvent((event) => {
      handleBridgeEvent(event);
    });
    return () => {
      clearLocalCorePolling();
      clearReplyTimeout();
      stopBridge();
    };
  }, [clearLocalCorePolling, clearReplyTimeout, handleBridgeEvent]);
}
