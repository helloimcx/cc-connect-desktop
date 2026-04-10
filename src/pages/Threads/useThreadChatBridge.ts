import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { bridgeSendMessage, onBridgeEvent } from '@/api/desktop';
import { getRuntimeBranding } from '@/lib/runtime-branding';
import {
  normalizePermissionResponse,
  supportsInteractivePermission,
  type DesktopBridgeButtonOption,
  type DesktopBridgeEvent,
} from '../../../shared/desktop';
import {
  isInternalProgressMessage,
  isPermissionActionRow,
  normalizeBridgeActionRows,
  sessionProjectFromKey,
  type ChatMessage,
  type ChatTaskState,
} from './thread-chat-model';

function permissionSupportMessage(agentType?: string) {
  const name = agentType || 'This agent';
  const branding = getRuntimeBranding();
  if (branding.permissionUnsupportedLabel.startsWith('This agent')) {
    return branding.permissionUnsupportedLabel;
  }
  return `${name} ${branding.permissionUnsupportedLabel.replace(/^This agent\s+/i, '')}`;
}

type UseThreadChatBridgeInput = {
  activeSessionAgentType: string;
  activeSessionId: string;
  activeSessionKey: string;
  messages: ChatMessage[];
  runtimeProvider: 'electron' | 'local_core' | 'web_remote';
  selectedProject: string;
  clearActionStatuses: () => void;
  clearLocalCorePolling: () => void;
  clearReplyTimeout: () => void;
  finalizeTurnMessages: (turnKey?: string) => void;
  nextProgressMessageId: (replyCtx?: string) => string;
  refreshSessionsForProject: (project: string) => Promise<unknown>;
  reserveAssistantMessageOrder: (sessionKey?: string) => number;
  reserveNextMessageOrder: () => number;
  setActiveRunId: Dispatch<SetStateAction<string>>;
  setBridgeError: Dispatch<SetStateAction<string>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setPendingBridgeActionId: Dispatch<SetStateAction<string | null>>;
  setTyping: Dispatch<SetStateAction<boolean>>;
  startLocalCoreThreadPolling: (threadId: string, baselineAssistantCount: number) => void;
  updateTaskState: (next: ChatTaskState) => void;
  armReplyTimeout: (mode?: 'reply' | 'permission_continue') => void;
  pendingTurnRef: MutableRefObject<{ sessionKey: string; userOrder: number } | null>;
  progressSequenceByTurnRef: MutableRefObject<Record<string, number>>;
  sendAction: (threadId: string, action: string) => Promise<{ runId: string }>;
};

export function useThreadChatBridge({
  activeSessionAgentType,
  activeSessionId,
  activeSessionKey,
  messages,
  runtimeProvider,
  selectedProject,
  clearActionStatuses,
  clearLocalCorePolling,
  clearReplyTimeout,
  finalizeTurnMessages,
  nextProgressMessageId,
  refreshSessionsForProject,
  reserveAssistantMessageOrder,
  reserveNextMessageOrder,
  setActiveRunId,
  setBridgeError,
  setMessages,
  setPendingBridgeActionId,
  setTyping,
  startLocalCoreThreadPolling,
  updateTaskState,
  armReplyTimeout,
  pendingTurnRef,
  progressSequenceByTurnRef,
  sendAction,
}: UseThreadChatBridgeInput) {
  const handleBridgeAction = useCallback(async (message: ChatMessage, action: DesktopBridgeButtonOption) => {
    if (!activeSessionId) {
      return;
    }
    const actionContent = normalizePermissionResponse(action.data) || action.data;
    const actionLabel = normalizePermissionResponse(action.data) || action.text || action.data;
    const userOrder = reserveNextMessageOrder();
    const actionMessageId = `${crypto.randomUUID()}-user-action`;
    let sent = false;
    setPendingBridgeActionId(message.id);
    setMessages((current) =>
      current.map((item) =>
        item.id === message.id
          ? { ...item, actionPending: true }
          : item,
      ),
    );
    try {
      setMessages((current) => [
        ...current,
        { id: actionMessageId, role: 'user', content: actionLabel, order: userOrder, timestamp: new Date().toISOString() },
      ]);
      if (runtimeProvider === 'local_core') {
        const result = await sendAction(activeSessionId, actionContent);
        setActiveRunId(result.runId);
        const assistantCount = messages.filter((item) => item.role === 'assistant').length;
        startLocalCoreThreadPolling(activeSessionId, assistantCount);
      } else {
        const [, project = selectedProject, chatId = 'main'] = activeSessionKey.split(':');
        await bridgeSendMessage({
          project,
          chatId,
          content: actionContent,
        });
      }
      sent = true;
      setBridgeError('');
      setTyping(runtimeProvider !== 'local_core');
      clearReplyTimeout();
      clearActionStatuses();
      if (message.actionMode === 'permission' && message.actionInteractive) {
        updateTaskState('permission_submitted');
        if (runtimeProvider !== 'local_core') {
          armReplyTimeout('permission_continue');
        }
        setMessages((current) =>
          current.map((item) =>
            item.id === message.id
              ? {
                  ...item,
                  actions: [],
                  actionPending: false,
                  actionStatus: 'Permission sent. Waiting for the agent to continue…',
                }
              : item,
          ),
        );
      } else {
        updateTaskState('running');
        if (runtimeProvider !== 'local_core') {
          armReplyTimeout();
        }
      }
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : 'Failed to send permission response.');
      setMessages((current) => current.filter((item) => item.id !== actionMessageId));
      updateTaskState(message.actionMode === 'permission' && message.actionInteractive ? 'awaiting_permission' : 'idle');
      setTyping(false);
    } finally {
      setPendingBridgeActionId(null);
      setMessages((current) =>
        current.map((item) =>
          item.id === message.id
            ? {
                ...item,
                actionPending: false,
                actions: sent ? item.actions || [] : item.actions,
              }
            : item,
        ),
      );
    }
  }, [
    activeSessionId,
    activeSessionKey,
    armReplyTimeout,
    clearActionStatuses,
    clearReplyTimeout,
    messages,
    reserveNextMessageOrder,
    runtimeProvider,
    selectedProject,
    sendAction,
    setActiveRunId,
    setBridgeError,
    setMessages,
    setPendingBridgeActionId,
    setTyping,
    startLocalCoreThreadPolling,
    updateTaskState,
  ]);

  const handleBridgeEvent = useCallback((event: DesktopBridgeEvent) => {
    const eventProject = sessionProjectFromKey(event.sessionKey);
    if (eventProject) {
      void refreshSessionsForProject(eventProject);
    }

    if (!event.sessionKey || event.sessionKey !== activeSessionKey) {
      return;
    }

    switch (event.type) {
      case 'preview_start':
        clearActionStatuses();
        setTyping(true);
        updateTaskState('running');
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
        clearActionStatuses();
        setTyping(true);
        updateTaskState('running');
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
        updateTaskState('running');
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
        clearActionStatuses();
        setTyping(true);
        updateTaskState('running');
        setBridgeError('');
        armReplyTimeout();
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
          const interactivePermission = isPermissionPrompt && supportsInteractivePermission(activeSessionAgentType);
          const nextActions = isPermissionPrompt && !interactivePermission ? [] : actionRows;
          const nextStatus = isPermissionPrompt && !interactivePermission
            ? permissionSupportMessage(activeSessionAgentType)
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
            supportsInteractivePermission(activeSessionAgentType)
            ? 'awaiting_permission'
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
    activeSessionAgentType,
    activeSessionKey,
    armReplyTimeout,
    clearActionStatuses,
    clearReplyTimeout,
    finalizeTurnMessages,
    nextProgressMessageId,
    pendingTurnRef,
    progressSequenceByTurnRef,
    refreshSessionsForProject,
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

  return {
    handleBridgeAction,
  };
}
