import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type {
  DesktopBridgeEvent,
  DesktopBridgeSendInput,
  DesktopBridgeSendResult,
  DesktopBridgeState,
  DesktopSettings,
} from '../shared/desktop.js';

const CAPABILITIES = ['preview', 'update_message', 'delete_message', 'typing', 'reconstruct_reply'];

export class BridgeAdapter extends EventEmitter {
  private socket: WebSocket | null = null;
  private state: DesktopBridgeState = { status: 'disconnected' };
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectPromise: Promise<DesktopBridgeState> | null = null;
  private resolveConnect: ((state: DesktopBridgeState) => void) | null = null;

  constructor(
    private readonly getSettings: () => DesktopSettings,
    private readonly isServiceRunning: () => boolean,
  ) {
    super();
  }

  getState() {
    return { ...this.state };
  }

  async connect() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return this.getState();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.state = { status: 'connecting' };
    this.emit('state');

    const settings = this.getSettings();
    const wsURL = `ws://127.0.0.1:${settings.bridgePort}${settings.bridgePath}?token=${encodeURIComponent(settings.bridgeToken)}`;

    this.connectPromise = new Promise<DesktopBridgeState>((resolve) => {
      this.resolveConnect = resolve;
      const socket = new WebSocket(wsURL);
      this.socket = socket;

      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            type: 'register',
            platform: 'desktop',
            capabilities: CAPABILITIES,
          }),
        );
      });

      socket.on('message', (data) => {
        this.handleMessage(String(data));
      });

      socket.on('close', () => {
        this.socket = null;
        if (this.state.status !== 'error') {
          this.state = { status: 'disconnected' };
          this.emit('state');
        }
        if (this.resolveConnect) {
          this.resolveConnect(this.getState());
          this.resolveConnect = null;
        }
        this.connectPromise = null;
        if (this.isServiceRunning()) {
          this.scheduleReconnect();
        }
      });

      socket.on('error', (error) => {
        this.state = { status: 'error', lastError: error.message };
        this.emit('state');
        if (this.resolveConnect) {
          this.resolveConnect(this.getState());
          this.resolveConnect = null;
        }
        this.connectPromise = null;
        if (this.isServiceRunning()) {
          this.scheduleReconnect();
        }
      });
    });

    return this.connectPromise;
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.state = { status: 'disconnected' };
    this.emit('state');
    return this.getState();
  }

  async sendMessage(input: DesktopBridgeSendInput): Promise<DesktopBridgeSendResult> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(this.state.lastError || 'Bridge is not connected');
    }

    const messageId = randomUUID();
    const sessionKey = `desktop:${input.project}:${input.chatId}`;
    const replyCtx = messageId;

    this.socket.send(
      JSON.stringify({
        type: 'message',
        msg_id: messageId,
        session_key: sessionKey,
        user_id: input.userId || 'desktop-user',
        user_name: input.userName || 'Desktop',
        content: input.content,
        reply_ctx: replyCtx,
      }),
    );

    return { messageId, sessionKey };
  }

  private handleMessage(raw: string) {
    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    switch (payload.type) {
      case 'register_ack':
        this.state = payload.ok
          ? { status: 'connected', connectedAt: new Date().toISOString() }
          : { status: 'error', lastError: payload.error || 'Bridge registration failed' };
        this.emit('state');
        if (this.resolveConnect) {
          this.resolveConnect(this.getState());
          this.resolveConnect = null;
          this.connectPromise = null;
        }
        this.emit('event', {
          type: 'register_ack',
          ok: Boolean(payload.ok),
          error: payload.error,
        } satisfies DesktopBridgeEvent);
        return;
      case 'preview_start': {
        const previewHandle = randomUUID();
        this.socket?.send(
          JSON.stringify({
            type: 'preview_ack',
            ref_id: payload.ref_id,
            preview_handle: previewHandle,
          }),
        );
        this.emit('event', {
          type: 'preview_start',
          sessionKey: payload.session_key,
          replyCtx: payload.reply_ctx,
          previewHandle,
          content: payload.content,
        } satisfies DesktopBridgeEvent);
        return;
      }
      case 'reply':
      case 'update_message':
      case 'delete_message':
      case 'typing_start':
      case 'typing_stop':
        this.emit('event', {
          type: payload.type,
          sessionKey: payload.session_key,
          replyCtx: payload.reply_ctx,
          previewHandle: payload.preview_handle,
          content: payload.content,
        } satisfies DesktopBridgeEvent);
        return;
      case 'card':
        this.emit('event', {
          type: 'card',
          sessionKey: payload.session_key,
          replyCtx: payload.reply_ctx,
          card: payload.card,
        } satisfies DesktopBridgeEvent);
        return;
      case 'buttons':
        this.emit('event', {
          type: 'buttons',
          sessionKey: payload.session_key,
          replyCtx: payload.reply_ctx,
          content: payload.content,
          buttons: payload.buttons,
        } satisfies DesktopBridgeEvent);
        return;
      default:
        return;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 2000);
  }
}
