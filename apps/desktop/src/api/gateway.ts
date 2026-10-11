// STUB (vokko-chat): minimal gateway bus matching shell's contract. Dropped at milestone A merge.
import type { GatewayEvents } from './types';

type AnyHandler = (d: unknown) => void;
type StatusHandler = (status: 'connecting' | 'open' | 'closed') => void;

const handlers = new Map<string, Set<AnyHandler>>();
const statusHandlers = new Set<StatusHandler>();

export const gateway = {
  connect(_token: string): void {},
  disconnect(): void {},
  send(_op: number, _d: unknown): void {},
  on<K extends keyof GatewayEvents>(t: K, fn: (d: GatewayEvents[K]) => void): () => void {
    let set = handlers.get(t);
    if (!set) { set = new Set(); handlers.set(t, set); }
    const target = set;
    target.add(fn as AnyHandler);
    return () => { target.delete(fn as AnyHandler); };
  },
  onStatus(fn: StatusHandler): () => void {
    statusHandlers.add(fn);
    return () => { statusHandlers.delete(fn); };
  },
  /** mock only */
  emit<K extends keyof GatewayEvents>(t: K, d: GatewayEvents[K]): void {
    queueMicrotask(() => { handlers.get(t)?.forEach(fn => fn(d)); });
  },
};
