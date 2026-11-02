import type {
  QiniuShareSessionInfo,
  QiniuShareSessionSource,
} from "@shared/qiniu.types";
import { create } from "zustand";
import { rpcCall } from "@/lib/rpc-client";

export interface QiniuShareCreateTarget {
  profileId: string;
  profileRevision: string;
  bucketName: string;
  prefix: string;
}

/** This store is deliberately memory-only; no links, codes or credentials persist. */
interface QiniuShareState {
  loginOpen: boolean;
  createTarget: QiniuShareCreateTarget | null;
  session: QiniuShareSessionInfo | null;
  sessionSource: QiniuShareSessionSource | null;
  openLogin: () => void;
  closeLogin: () => void;
  openCreate: (target: QiniuShareCreateTarget) => void;
  closeCreate: () => void;
  adoptSession: (
    session: QiniuShareSessionInfo,
    source?: QiniuShareSessionSource,
  ) => void;
  closeSession: () => void;
  reset: () => void;
}

export function discardQiniuShareSession(sessionId: string): void {
  void rpcCall("qiniu:share-close", { sessionId }).catch(() => {});
}

export const useQiniuShareStore = create<QiniuShareState>()((set, get) => ({
  loginOpen: false,
  createTarget: null,
  session: null,
  sessionSource: null,
  openLogin: () => set({ loginOpen: true }),
  closeLogin: () => set({ loginOpen: false }),
  openCreate: (target) => set({ createTarget: { ...target } }),
  closeCreate: () => set({ createTarget: null }),
  adoptSession: (session, source) => {
    const old = get().session;
    if (old && old.sessionId !== session.sessionId)
      discardQiniuShareSession(old.sessionId);
    // Build an allowlisted DTO, even if a caller has widened its static type.
    set({
      sessionSource: source
        ? {
            profileSetFingerprint: source.profileSetFingerprint,
            ...(source.privateEnvironmentId
              ? {
                  privateEnvironmentId: source.privateEnvironmentId,
                  privateEnvironmentRevision: source.privateEnvironmentRevision,
                  privateEnvironmentFingerprint:
                    source.privateEnvironmentFingerprint,
                }
              : {}),
          }
        : null,
      session: {
        sessionId: session.sessionId,
        bucketName: session.bucketName,
        prefix: session.prefix,
        expiresAt: session.expiresAt,
        readOnly: true,
      },
    });
  },
  closeSession: () => {
    const old = get().session;
    set({ session: null, sessionSource: null });
    if (old) discardQiniuShareSession(old.sessionId);
  },
  reset: () => {
    const old = get().session;
    set({
      loginOpen: false,
      createTarget: null,
      session: null,
      sessionSource: null,
    });
    if (old) discardQiniuShareSession(old.sessionId);
  },
}));
