import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { getRuntimeProvider } from '@/app/runtime';
import { getRuntimeStatus, onRuntimeEvent } from '@/api/desktop';
import type { DesktopRuntimeStatus } from '../../../shared/desktop';
import type { ChatTaskState } from './thread-chat-model';

type UseThreadChatRuntimeStateInput = {
  requestedProject: string;
  selectedProject: string;
  setSelectedProject: Dispatch<SetStateAction<string>>;
  clearReplyTimeout: () => void;
  updateTaskState: (next: ChatTaskState) => void;
  setTyping: Dispatch<SetStateAction<boolean>>;
};

export function useThreadChatRuntimeState({
  requestedProject,
  selectedProject,
  setSelectedProject,
  clearReplyTimeout,
  updateTaskState,
  setTyping,
}: UseThreadChatRuntimeStateInput) {
  const [runtime, setRuntime] = useState<DesktopRuntimeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const runtimeProvider = getRuntimeProvider();
  const showSessionKey = runtimeProvider === 'electron';

  const serviceRunning = runtime?.phase === 'api_ready' || runtime?.phase === 'bridge_ready';
  const bridgeConnected = runtime?.bridge.status === 'connected';
  const transportReady = runtimeProvider === 'local_core' ? serviceRunning : bridgeConnected;

  const refreshRuntime = useCallback(async () => {
    const nextRuntime = await getRuntimeStatus();
    setRuntime(nextRuntime);
    if (!nextRuntime.service.lastError && !selectedProject) {
      setSelectedProject(requestedProject || nextRuntime.settings.defaultProject);
    }
  }, [requestedProject, selectedProject, setSelectedProject]);

  useEffect(() => {
    void refreshRuntime().finally(() => setLoading(false));
    const stopRuntime = onRuntimeEvent((nextRuntime) => {
      setRuntime(nextRuntime);
      if (nextRuntime.phase === 'stopped' || nextRuntime.phase === 'error') {
        setTyping(false);
        clearReplyTimeout();
        updateTaskState('idle');
      }
    });
    return () => {
      clearReplyTimeout();
      stopRuntime();
    };
  }, [
    clearReplyTimeout,
    refreshRuntime,
    setTyping,
    updateTaskState,
  ]);

  return useMemo(() => ({
    loading,
    refreshRuntime,
    runtime,
    runtimeProvider,
    serviceRunning,
    showSessionKey,
    transportReady,
  }), [
    loading,
    refreshRuntime,
    runtime,
    runtimeProvider,
    serviceRunning,
    showSessionKey,
    transportReady,
  ]);
}
