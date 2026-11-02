import type { QiniuShareSessionSource } from "@shared/qiniu.types";
import { useEffect, useRef } from "react";
import { t } from "@/lib/i18n";
import { rpcCall } from "@/lib/rpc-client";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useVaultStore,
} from "@/stores";
import {
  discardQiniuShareSession as discardNativeQiniuShareSession,
  useQiniuShareStore,
} from "@/stores/useQiniuShareStore";
import { QiniuDirectoryShare } from "./QiniuDirectoryShare";
import { QiniuShareBrowser } from "./QiniuShareBrowser";
import { QiniuShareLogin } from "./QiniuShareLogin";
import {
  isCurrentQiniuShareSessionSource,
  isCurrentQiniuShareTarget,
  qiniuPrivateShareEnvironment,
  qiniuShareProfileSetFingerprint,
  verifyConfiguredQiniuShareSession,
} from "./qiniu-share-scope";

/** Separates temporary read-only sessions from account tabs and whole-bucket usage. */
export function QiniuShareWorkspace() {
  const unlocked = useVaultStore((state) => state.unlocked);
  const profiles = useVaultStore((state) => state.profiles);
  const profileId = useProfileStore((state) => state.activeProfileId);
  const bucket = useBucketStore((state) => state.selectedBucket);
  const prefix = useObjectStore((state) => state.currentPrefix);
  const loginOpen = useQiniuShareStore((state) => state.loginOpen);
  const target = useQiniuShareStore((state) => state.createTarget);
  const session = useQiniuShareStore((state) => state.session);
  const sessionSource = useQiniuShareStore((state) => state.sessionSource);
  const verifiedSources = useRef(new Map<string, QiniuShareSessionSource>());
  const discardQiniuShareSession = (id: string) => {
    verifiedSources.current.delete(id);
    discardNativeQiniuShareSession(id);
  };
  const closeLogin = useQiniuShareStore((state) => state.closeLogin);
  const closeCreate = useQiniuShareStore((state) => state.closeCreate);
  const closeSession = useQiniuShareStore((state) => state.closeSession);
  const adoptSession = useQiniuShareStore((state) => state.adoptSession);
  const reset = useQiniuShareStore((state) => state.reset);
  const profile = profiles.find((item) => item.id === profileId);
  const profileSetFingerprint = qiniuShareProfileSetFingerprint(profiles);
  const privateEnvironments = profiles.flatMap((item) => {
    const environment = qiniuPrivateShareEnvironment(item);
    return environment ? [environment] : [];
  });
  const currentSession =
    session &&
    sessionSource &&
    isCurrentQiniuShareSessionSource(sessionSource, profiles)
      ? session
      : null;
  const currentTarget =
    unlocked &&
    target &&
    isCurrentQiniuShareTarget(target, profile, bucket, prefix)
      ? target
      : null;

  useEffect(() => {
    if (target && !currentTarget) closeCreate();
  }, [target, currentTarget, closeCreate]);
  useEffect(() => {
    if (!unlocked) reset();
  }, [unlocked, reset]);
  useEffect(() => {
    if (session && !currentSession) closeSession();
  }, [session, currentSession, closeSession]);
  useEffect(() => {
    if (!profileSetFingerprint) return;
    verifiedSources.current.clear();
  }, [profileSetFingerprint]);
  useEffect(() => () => reset(), [reset]);

  return (
    <>
      {currentTarget && (
        <QiniuDirectoryShare
          open
          scopeId={JSON.stringify(currentTarget)}
          bucketName={currentTarget.bucketName}
          prefix={currentTarget.prefix}
          allowedPrefix=""
          capability={{
            state: "supported",
            reason: t(
              "提供创建入口；实际空间权限和服务可用性仍由后端请求确认。",
              "Creation is available; actual bucket permissions and service availability are checked by the backend request.",
            ),
          }}
          onClose={closeCreate}
          onCreate={async (input) => {
            const latest = useVaultStore.getState();
            if (
              !latest.unlocked ||
              !isCurrentQiniuShareTarget(
                currentTarget,
                latest.profiles.find(
                  (item) =>
                    item.id === useProfileStore.getState().activeProfileId,
                ),
                useBucketStore.getState().selectedBucket,
                useObjectStore.getState().currentPrefix,
              )
            )
              throw new Error(
                t(
                  "账号或目录已变化，请重新打开分享。",
                  "The account or directory changed. Open sharing again.",
                ),
              );
            return rpcCall("qiniu:share-create", {
              ...input,
              profileId: currentTarget.profileId,
              expectedProfileRevision: currentTarget.profileRevision,
            });
          }}
        />
      )}
      <QiniuShareLogin
        open={unlocked && loginOpen}
        scopeId={profileSetFingerprint}
        privateEnvironments={privateEnvironments}
        onClose={closeLogin}
        onVerify={async (input) => {
          const result = await verifyConfiguredQiniuShareSession(
            input,
            () => useVaultStore.getState(),
            (request) => rpcCall("qiniu:share-login", request),
            discardQiniuShareSession,
          );
          verifiedSources.current.set(result.session.sessionId, result.source);
          return result.session;
        }}
        onOpenSession={(value) => {
          if (!useVaultStore.getState().unlocked)
            throw new Error(
              t(
                "密码库已锁定，请重新解锁。",
                "The vault is locked. Unlock it again.",
              ),
            );
          const source = verifiedSources.current.get(value.sessionId);
          if (
            !source ||
            !isCurrentQiniuShareSessionSource(
              source,
              useVaultStore.getState().profiles,
            )
          )
            throw new Error(
              t(
                "保存的分享环境已变化，请重新验证。",
                "The saved share environment changed. Verify again.",
              ),
            );
          verifiedSources.current.delete(value.sessionId);
          adoptSession(value, source);
        }}
        onDiscardSession={discardQiniuShareSession}
      />
      {unlocked && currentSession && (
        <QiniuShareBrowser
          key={currentSession.sessionId}
          session={currentSession}
          onClose={closeSession}
          onExpire={discardQiniuShareSession}
        />
      )}
    </>
  );
}
