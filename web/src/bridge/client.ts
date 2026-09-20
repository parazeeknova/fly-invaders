/**
 * WebSocket bridge to the Python fly brain. One singleton; the game sends frames,
 * the UI reads the store (./store.ts). Reconnects automatically.
 */
import {
  BRAIN_WS_URL,
  type ActionMessage,
  type ClientMessage,
  type FrameMessage,
  type HelloMessage,
  type ServerMessage,
} from '../protocol';
import { store } from './store';

export type ConnectionState = 'disconnected' | 'connecting' | 'open';

type ActionListener = (action: ActionMessage) => void;

class BrainClient {
  private socket: WebSocket | null = null;
  private hello: HelloMessage | null = null;
  private actionListeners = new Set<ActionListener>();
  private retry: ReturnType<typeof setTimeout> | null = null;
  private url = BRAIN_WS_URL;

  /** Connect (or reconnect) and announce ourselves. Safe to call repeatedly. */
  connect(hello: HelloMessage, url = BRAIN_WS_URL) {
    this.hello = hello;
    this.url = url;
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
      if (this.socket.readyState === WebSocket.OPEN) this.raw(hello);
      return;
    }
    this.open();
  }

  private open() {
    if (!this.hello) return;
    store.setConnection('connecting');
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      // Hello must be the first message; only then tell the store (which may start a run).
      if (this.hello) this.raw(this.hello);
      store.setConnection('open');
    };
    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === 'action') {
        store.onAction(message);
        for (const listener of this.actionListeners) listener(message);
      } else if (message.type === 'welcome') {
        store.onWelcome(message);
      } else if (message.type === 'status') {
        store.onStatus(message);
      } else if (message.type === 'role') {
        store.onRole(message.role);
      }
    };
    socket.onclose = () => {
      store.setConnection('disconnected');
      this.socket = null;
      this.scheduleRetry();
    };
    socket.onerror = () => socket.close();
  }

  private scheduleRetry() {
    if (this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.open();
    }, 1500);
  }

  get isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Send one pre-action frame. The game must wait for the matching action before stepping. */
  sendFrame(frame: FrameMessage) {
    if (typeof frame.pixels === 'string') {
      this.raw(frame);
      return;
    }
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const { pixels, ...header } = frame;
    const head = new TextEncoder().encode(JSON.stringify(header));
    const packet = new Uint8Array(4 + head.length + pixels.length);
    new DataView(packet.buffer).setUint32(0, head.length, true);
    packet.set(head, 4);
    packet.set(pixels, 4 + head.length);
    this.socket.send(packet);
  }

  onAction(listener: ActionListener) {
    this.actionListeners.add(listener);
    return () => this.actionListeners.delete(listener);
  }

  private raw(message: ClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  close() {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.hello = null;
    this.socket?.close();
    this.socket = null;
  }
}

export const brainClient = new BrainClient();
