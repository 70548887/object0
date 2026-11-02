import type {
  QiniuShareLoginInput,
  QiniuSharePrivateEnvironment,
} from "@shared/qiniu.types";
import { useCallback, useEffect, useId, useRef, useState } from "react";

export type {
  QiniuShareLoginInput,
  QiniuSharePrivateEnvironment,
} from "@shared/qiniu.types";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { intlLocale, localize, t, useT } from "@/lib/i18n";
import {
  normalizeQiniuSharePrefix,
  qiniuShareDisplayError,
  validateQiniuShareUrl,
} from "./QiniuDirectoryShare";

export interface QiniuShareSessionInfo {
  sessionId: string;
  bucketName: string;
  prefix: string;
  expiresAt: string;
  readOnly: true;
}
export interface QiniuShareLoginProps {
  open: boolean;
  scopeId: string;
  initialUrl?: string;
  privateEnvironments?: readonly QiniuSharePrivateEnvironment[];
  onClose: () => void;
  onVerify: (input: QiniuShareLoginInput) => Promise<QiniuShareSessionInfo>;
  /** Synchronously takes ownership before navigating or unmounting this dialog. */
  onOpenSession: (session: QiniuShareSessionInfo) => void;
  /** Drops a local, unclaimed session. This does not revoke the remote share. */
  onDiscardSession: (sessionId: string) => void | Promise<void>;
}

function sessionIdFrom(value: unknown): string | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    !value.sessionId ||
    value.sessionId.length > 512 ||
    /[\0\r\n]/.test(value.sessionId)
  )
    return null;
  return value.sessionId;
}

export function parseQiniuShareSession(
  value: unknown,
  now = Date.now(),
): QiniuShareSessionInfo {
  const allowed = [
    "sessionId",
    "bucketName",
    "prefix",
    "expiresAt",
    "readOnly",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error(
      t(
        "分享服务返回了非预期会话字段，未建立连接。",
        "The share service returned unexpected session fields. No connection was established.",
      ),
    );
  const info = value as Record<string, unknown>;
  const sessionId = sessionIdFrom(value);
  const prefix =
    typeof info.prefix === "string"
      ? normalizeQiniuSharePrefix(info.prefix)
      : null;
  if (
    !Number.isFinite(now) ||
    !sessionId ||
    typeof info.bucketName !== "string" ||
    !info.bucketName ||
    info.bucketName.length > 255 ||
    prefix === null ||
    info.prefix !== prefix ||
    info.readOnly !== true ||
    typeof info.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(info.expiresAt)) ||
    Date.parse(info.expiresAt) <= now
  )
    throw new Error(
      t(
        "分享会话的范围、只读权限或有效期无效，未建立连接。",
        "The share session has an invalid scope, read-only permission or expiry. No connection was established.",
      ),
    );
  return {
    sessionId,
    bucketName: info.bucketName,
    prefix,
    expiresAt: info.expiresAt,
    readOnly: true,
  };
}

function discardSafely(
  sessionId: string,
  discard: QiniuShareLoginProps["onDiscardSession"],
): void {
  try {
    const result = discard(sessionId);
    if (result && typeof result.then === "function")
      void result.catch(() => {});
  } catch {
    /* Cleanup is best effort; the backend must enforce session expiry. */
  }
}

export async function requestQiniuShareSession(
  input: QiniuShareLoginInput,
  verify: QiniuShareLoginProps["onVerify"],
  isCurrent: () => boolean,
  discard: QiniuShareLoginProps["onDiscardSession"],
): Promise<QiniuShareSessionInfo | null> {
  if (
    !validateQiniuShareUrl(input.url).valid ||
    !/^[A-Za-z0-9]{6}$/.test(input.extractionCode)
  )
    throw new Error(
      t(
        "分享链接或提取码格式无效。",
        "Invalid share URL or extraction-code format.",
      ),
    );
  let candidateId: string | null = null;
  try {
    const response = await verify(input);
    candidateId = sessionIdFrom(response);
    const session = parseQiniuShareSession(response);
    if (!isCurrent()) {
      discardSafely(session.sessionId, discard);
      candidateId = null;
      return null;
    }
    return session;
  } catch (cause) {
    if (candidateId) discardSafely(candidateId, discard);
    throw cause;
  }
}

export function QiniuShareSessionSummary({
  session,
}: {
  session: QiniuShareSessionInfo;
}) {
  const t = useT();
  return (
    <section
      aria-label={t(
        "已验证的只读共享目录",
        "Verified read-only shared directory",
      )}
      className="min-w-0 space-y-2 text-xs"
    >
      <p className="font-medium text-foreground">
        {t("只读共享会话已验证", "Read-only share session verified")}
      </p>
      <dl className="space-y-2">
        <div className="space-y-0.5">
          <dt className="text-muted-foreground">{t("空间", "Bucket")}</dt>
          <dd className="m-0 break-all">{session.bucketName}</dd>
        </div>
        <div className="space-y-0.5">
          <dt className="text-muted-foreground">
            {t("授权目录", "Authorized directory")}
          </dt>
          <dd className="m-0 break-all font-mono">{session.prefix || "/"}</dd>
        </div>
        <div className="space-y-0.5">
          <dt className="text-muted-foreground">
            {t("到期时间", "Expires at")}
          </dt>
          <dd className="m-0 break-words">
            {new Date(session.expiresAt).toLocaleString(intlLocale(), {
              hour12: false,
            })}
          </dd>
        </div>
      </dl>
      <p className="leading-relaxed text-muted-foreground">
        {t(
          "只能读取授权目录，不能上传、修改、删除或访问其他路径。会话过期后需重新验证。",
          "Only the authorized directory can be read. Uploads, modifications, deletion and other paths are unavailable. Verify again after the session expires.",
        )}
      </p>
    </section>
  );
}

export function QiniuShareLoginFields({
  url,
  extractionCode,
  privateEnvironmentId,
  privateEnvironments,
  disabled,
  onUrlChange,
  onCodeChange,
  onEnvironmentChange,
}: {
  url: string;
  extractionCode: string;
  privateEnvironmentId: string;
  privateEnvironments: readonly QiniuSharePrivateEnvironment[];
  disabled: boolean;
  onUrlChange: (value: string) => void;
  onCodeChange: (value: string) => void;
  onEnvironmentChange: (value: string) => void;
}) {
  const t = useT();
  const id = useId();
  const environment = privateEnvironments.find(
    (value) => value.id === privateEnvironmentId,
  );
  return (
    <div className="min-w-0 space-y-3">
      {(privateEnvironments.length > 0 || privateEnvironmentId !== "") && (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-environment`}>
            {t("服务环境", "Service environment")}
          </Label>
          <select
            id={`${id}-environment`}
            className="h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            value={privateEnvironmentId}
            disabled={disabled}
            onChange={(event) => onEnvironmentChange(event.target.value)}
          >
            <option value="">{t("七牛公有云", "Qiniu public cloud")}</option>
            {privateEnvironmentId && !environment && (
              <option value={privateEnvironmentId} disabled>
                {t("已移除的私有环境", "Removed private environment")}
              </option>
            )}
            {privateEnvironments.map((environment) => (
              <option
                key={environment.id}
                value={environment.id}
                disabled={environment.disabled}
              >
                {environment.label} ·{" "}
                {environment.disabled
                  ? t("配置不完整", "Incomplete configuration")
                  : t("待实机验收", "Deployment validation pending")}
              </option>
            ))}
          </select>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t(
              "私有云只能使用已配置的环境，链接返回的域名不会自动成为可信地址。",
              "Private clouds must use a configured environment. A domain returned by the link is not automatically trusted.",
            )}
          </p>
          {privateEnvironments.some((value) => value.disabled) && (
            <details className="text-xs leading-relaxed text-muted-foreground">
              <summary className="cursor-pointer">
                {t(
                  "查看未配置完成的私有环境",
                  "Review incomplete private environments",
                )}
              </summary>
              <ul className="mt-1 space-y-1">
                {privateEnvironments
                  .filter((value) => value.disabled)
                  .map((value) => (
                    <li key={value.id} className="break-words">
                      {value.label}：
                      {value.reason
                        ? localize(value.reason)
                        : t(
                            "请检查账号的分享配置。",
                            "Review the account share configuration.",
                          )}
                    </li>
                  ))}
              </ul>
            </details>
          )}
          {environment && (
            <div className="space-y-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed">
              <p className="font-medium">
                {t(
                  "私有云：待实机验收",
                  "Private cloud: deployment validation pending",
                )}
              </p>
              {environment.portalOrigin && (
                <p className="break-all">
                  {t("已保存门户：", "Saved portal: ")}
                  {environment.portalOrigin}
                </p>
              )}
              {environment.apiOrigin && (
                <p className="break-all">
                  {t("已保存分享 API：", "Saved share API: ")}
                  {environment.apiOrigin}
                </p>
              )}
              {environment.reason && (
                <p role="status" className="text-warning">
                  {localize(environment.reason)}
                </p>
              )}
              {environment.insecure && (
                <p role="status" className="text-warning">
                  {t(
                    "所选环境的 UC、门户、API 或 S3 地址使用明文 HTTP，链接、提取码或凭据可能被网络监听。",
                    "The selected UC, portal, API or S3 endpoint uses plaintext HTTP. Links, extraction codes or credentials may be exposed on the network.",
                  )}
                </p>
              )}
              <p className="text-muted-foreground">
                {t(
                  "仅使用此环境的已保存地址；不会向分享登录发送账号长期密钥。",
                  "Only this environment's saved addresses are used. Long-term account keys are not sent during share login.",
                )}
              </p>
            </div>
          )}
          {privateEnvironmentId && !environment && (
            <p role="alert" className="text-xs text-destructive">
              {t(
                "所选私有环境已移除，请明确重新选择；不会自动改用公有云。",
                "The selected private environment was removed. Select an environment explicitly; public cloud will not be used automatically.",
              )}
            </p>
          )}
        </div>
      )}
      {privateEnvironments.length === 0 && !privateEnvironmentId && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(
            "如需连接私有云，请先在账号设置中配置分享门户、分享 API 和手工区域。私有部署仍需实机验收。",
            "For private cloud, first configure a share portal, share API and manual region in account settings. Private deployments still require validation.",
          )}
        </p>
      )}
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-url`}>
          {t("目录分享链接", "Directory-share URL")}
        </Label>
        <Input
          id={`${id}-url`}
          type="url"
          className="min-w-0 font-mono text-xs"
          value={url}
          disabled={disabled}
          onChange={(event) => onUrlChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="https://…"
          aria-describedby={`${id}-url-help`}
        />
        <p
          id={`${id}-url-help`}
          className="text-xs leading-relaxed text-muted-foreground"
        >
          {t(
            "链接可能包含授权令牌，不会写入登录历史或日志；服务身份由本机后端验证。",
            "The URL may contain an authorization token. It is not written to login history or logs; the local backend validates the service identity.",
          )}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-code`}>
          {t("六位提取码", "Six-character extraction code")}
        </Label>
        <Input
          id={`${id}-code`}
          type="password"
          value={extractionCode}
          disabled={disabled}
          onChange={(event) => onCodeChange(event.target.value)}
          minLength={6}
          maxLength={6}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby={`${id}-code-help`}
        />
        <p id={`${id}-code-help`} className="text-xs text-muted-foreground">
          {t(
            "请输入 6 位英文字母或数字，保留原大小写。",
            "Enter 6 letters or digits, preserving the original case.",
          )}
        </p>
      </div>
      {validateQiniuShareUrl(url).insecure && (
        <p className="text-xs leading-relaxed text-warning">
          {t(
            "该链接使用未加密 HTTP，请核对所选环境。",
            "This URL uses unencrypted HTTP. Review the selected environment.",
          )}
        </p>
      )}
    </div>
  );
}

export function QiniuShareLogin({
  open,
  scopeId,
  initialUrl = "",
  privateEnvironments = [],
  onClose,
  onVerify,
  onOpenSession,
  onDiscardSession,
}: QiniuShareLoginProps) {
  const t = useT();
  const [environmentId, setEnvironmentId] = useState("");
  const environment = privateEnvironments.find(
    (value) => value.id === environmentId,
  );
  // This identity remains memory-only. Never send it to logs, storage or telemetry.
  const scope = JSON.stringify([
    open,
    scopeId,
    initialUrl,
    environmentId,
    environment?.revision,
    environment?.configFingerprint,
    environment?.disabled,
  ]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const generation = useRef(0);
  const requestPending = useRef(false);
  const [url, setUrl] = useState(initialUrl);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [session, setSession] = useState<{
    scope: string;
    value: QiniuShareSessionInfo;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const held = useRef<{
    session: QiniuShareSessionInfo;
    discard: QiniuShareLoginProps["onDiscardSession"];
  } | null>(null);
  const release = useCallback(() => {
    const current = held.current;
    held.current = null;
    if (current) discardSafely(current.session.sessionId, current.discard);
  }, []);
  useEffect(() => {
    if (!scope) return;
    generation.current++;
    requestPending.current = false;
    const previous = held.current;
    held.current = null;
    if (previous) discardSafely(previous.session.sessionId, previous.discard);
    setUrl(open ? initialUrl : "");
    setCode("");
    setPending(false);
    setSession(null);
    setError(null);
    return () => {
      generation.current++;
      requestPending.current = false;
      const current = held.current;
      held.current = null;
      if (current) discardSafely(current.session.sessionId, current.discard);
    };
  }, [scope, open, initialUrl]);
  const visible = session?.scope === scope ? session.value : null;
  useEffect(() => {
    if (!visible) return;
    const expected = visible.sessionId;
    const timer = window.setTimeout(
      () => {
        if (
          latestScope.current !== scope ||
          held.current?.session.sessionId !== expected
        )
          return;
        release();
        setSession(null);
        setUrl("");
        setCode("");
        setError(
          t(
            "只读共享会话已过期，请重新输入链接和提取码验证。",
            "The read-only share session expired. Enter the URL and extraction code to verify again.",
          ),
        );
      },
      Math.min(
        2147483647,
        Math.max(0, Date.parse(visible.expiresAt) - Date.now()),
      ),
    );
    return () => window.clearTimeout(timer);
  }, [visible, scope, t, release]);
  const close = () => {
    generation.current++;
    requestPending.current = false;
    release();
    setUrl("");
    setCode("");
    setSession(null);
    setError(null);
    setPending(false);
    setEnvironmentId("");
    onClose();
  };
  const verify = async () => {
    if (!open || pending || requestPending.current) return;
    const validEnvironment =
      environmentId === "" ||
      Boolean(environment && !environment.disabled && environment.revision);
    if (
      !validateQiniuShareUrl(url.trim()).valid ||
      !/^[A-Za-z0-9]{6}$/.test(code) ||
      !validEnvironment
    ) {
      setError(
        t(
          "请填写有效的 HTTP(S) 分享链接、六位提取码，并核对服务环境。",
          "Enter a valid HTTP(S) share URL and six-character extraction code, and check the service environment.",
        ),
      );
      return;
    }
    release();
    setSession(null);
    setError(null);
    setPending(true);
    requestPending.current = true;
    const request = ++generation.current;
    const discard = onDiscardSession;
    try {
      const info = await requestQiniuShareSession(
        {
          url: url.trim(),
          extractionCode: code,
          ...(environmentId
            ? {
                privateEnvironmentId: environmentId,
                expectedPrivateEnvironmentRevision: environment?.revision,
              }
            : {}),
        },
        onVerify,
        () => generation.current === request && latestScope.current === scope,
        discard,
      );
      if (!info) return;
      held.current = { session: info, discard };
      setSession({ scope, value: info });
      setUrl("");
      setCode("");
    } catch (cause) {
      if (generation.current === request && latestScope.current === scope)
        setError(
          qiniuShareDisplayError(
            cause,
            t(
              "共享目录验证失败，请检查链接和提取码。",
              "Share verification failed. Check the URL and extraction code.",
            ),
            [url, code],
          ),
        );
    } finally {
      if (generation.current === request && latestScope.current === scope) {
        requestPending.current = false;
        setPending(false);
      }
    }
  };
  const enter = () => {
    if (
      !visible ||
      !held.current ||
      Date.parse(visible.expiresAt) <= Date.now()
    )
      return;
    const current = held.current;
    held.current = null;
    try {
      onOpenSession(visible);
    } catch (cause) {
      held.current = current;
      setError(
        cause instanceof Error
          ? cause.message
          : t("无法打开共享目录。", "Could not open the shared directory."),
      );
      return;
    }
    // Once ownership has moved to the parent, a close-handler error must not
    // accidentally reacquire and discard that now-active session.
    generation.current++;
    setSession(null);
    setUrl("");
    setCode("");
    onClose();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <DialogContent className="max-h-[90dvh] min-w-0 overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("连接七牛共享目录", "Connect to a Qiniu shared directory")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "使用目录分享链接和提取码建立临时只读会话，不保存账号凭据。",
              "Use a directory-share URL and extraction code to establish a temporary read-only session without saving account credentials.",
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (visible) enter();
            else void verify();
          }}
        >
          {visible ? (
            <QiniuShareSessionSummary session={visible} />
          ) : (
            <QiniuShareLoginFields
              url={url}
              extractionCode={code}
              privateEnvironmentId={environmentId}
              privateEnvironments={privateEnvironments}
              disabled={pending}
              onUrlChange={setUrl}
              onCodeChange={setCode}
              onEnvironmentChange={setEnvironmentId}
            />
          )}
          {error && (
            <p
              role="alert"
              className="break-words text-xs leading-relaxed text-destructive"
            >
              {localize(error)}
            </p>
          )}
          {pending && (
            <p role="status" className="text-xs text-muted-foreground">
              {t("正在验证共享目录…", "Verifying the shared directory…")}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("关闭", "Close")}
            </Button>
            {visible ? (
              <Button type="submit">
                {t("打开共享目录", "Open shared directory")}
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={
                  pending ||
                  !validateQiniuShareUrl(url.trim()).valid ||
                  !/^[A-Za-z0-9]{6}$/.test(code) ||
                  (environmentId !== "" &&
                    (!environment ||
                      environment.disabled ||
                      !environment.revision))
                }
                aria-busy={pending}
              >
                {pending
                  ? t("正在验证…", "Verifying…")
                  : t("验证只读会话", "Verify read-only session")}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
