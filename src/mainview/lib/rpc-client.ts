import type { RPCEvents, RPCSchema } from "@shared/rpc-schema";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type EventHandler<E extends keyof RPCEvents> = (data: RPCEvents[E]) => void;

const eventListeners = new Map<
  keyof RPCEvents,
  Set<EventHandler<keyof RPCEvents>>
>();
const tauriUnlisteners = new Map<keyof RPCEvents, Promise<UnlistenFn>>();

function dispatchEvent<E extends keyof RPCEvents>(
  event: E,
  data: RPCEvents[E],
): void {
  const listeners = eventListeners.get(event);
  if (!listeners) return;

  for (const handler of listeners) {
    try {
      handler(data as RPCEvents[keyof RPCEvents]);
    } catch {
      // Never let one listener break the rest.
    }
  }
}

async function ensureTauriListener<E extends keyof RPCEvents>(
  event: E,
): Promise<void> {
  if (tauriUnlisteners.has(event)) return;

  tauriUnlisteners.set(
    event,
    listen<RPCEvents[E]>(event as string, (tauriEvent) => {
      dispatchEvent(event, tauriEvent.payload);
    }),
  );
}

function cleanupTauriListener<E extends keyof RPCEvents>(event: E): void {
  const listeners = eventListeners.get(event);
  if (listeners && listeners.size > 0) return;

  const unlistenPromise = tauriUnlisteners.get(event);
  if (!unlistenPromise) return;

  tauriUnlisteners.delete(event);
  unlistenPromise
    .then((unlisten) => unlisten())
    .catch(() => {
      // Best-effort cleanup.
    });
}

// ── Make an RPC call to the Rust backend ──
export async function rpcCall<M extends keyof RPCSchema>(
  method: M,
  payload: RPCSchema[M]["req"],
): Promise<RPCSchema[M]["res"]> {
  try {
    return await invoke<RPCSchema[M]["res"]>("rpc_request", {
      method,
      payload: payload ?? null,
    });
  } catch (error: unknown) {
    // Tauri rejects Result<_, String> as a string, not a JavaScript Error.
    // Normalize once so callers do not silently replace useful errors with
    // "未知错误". Never serialize arbitrary objects or the request payload.
    if (error instanceof Error) throw error;
    if (typeof error === "string" && error.trim()) {
      throw new Error(error);
    }
    if (
      error &&
      typeof error === "object" &&
      "message" in error &&
      typeof error.message === "string" &&
      error.message.trim()
    ) {
      throw new Error(error.message);
    }
    throw new Error("请求失败，后端未返回具体原因，请重试");
  }
}

// ── Subscribe to backend events ──
export function onEvent<E extends keyof RPCEvents>(
  event: E,
  handler: EventHandler<E>,
): () => void {
  if (!eventListeners.has(event)) {
    eventListeners.set(event, new Set());
  }

  eventListeners.get(event)?.add(handler as EventHandler<keyof RPCEvents>);
  void ensureTauriListener(event);

  return () => {
    eventListeners.get(event)?.delete(handler as EventHandler<keyof RPCEvents>);
    cleanupTauriListener(event);
  };
}
