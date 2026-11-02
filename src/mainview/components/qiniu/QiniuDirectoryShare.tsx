import { useEffect, useId, useRef, useState } from "react";
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
import { QiniuCapabilityNote } from "./QiniuCapabilityNote";
import { isQiniuCapabilityAllowed, type QiniuCapability } from "./types";

export interface QiniuDirectoryShareCreateInput {
  bucketName: string;
  prefix: string;
  durationSeconds: number;
  readOnly: true;
}
export interface QiniuDirectoryShareResult {
  url: string;
  extractionCode: string;
  bucketName: string;
  prefix: string;
  expiresAt: string;
  readOnly: true;
}
export interface QiniuDirectoryShareProps {
  open: boolean;
  scopeId: string;
  bucketName: string;
  prefix: string;
  allowedPrefix: string;
  capability: QiniuCapability;
  onClose: () => void;
  onCreate: (
    input: QiniuDirectoryShareCreateInput,
  ) => Promise<QiniuDirectoryShareResult>;
  onCopy?: (value: string) => Promise<void>;
}

export function normalizeQiniuSharePrefix(prefix: string): string | null {
  if (
    prefix.startsWith("/") ||
    prefix.includes("\\") ||
    /[\0\r\n]/.test(prefix) ||
    prefix.split("/").some((part) => part === "." || part === "..")
  )
    return null;
  return prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`;
}

export function isQiniuSharePrefixAllowed(
  prefix: string,
  allowedPrefix: string,
): boolean {
  const normalized = normalizeQiniuSharePrefix(prefix);
  const root = normalizeQiniuSharePrefix(allowedPrefix);
  return (
    normalized !== null &&
    root !== null &&
    (root === "" || normalized.startsWith(root))
  );
}

export function parseQiniuDirectoryShareMinutes(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const minutes = Number(value.trim());
  return Number.isInteger(minutes) && minutes >= 15 && minutes <= 120
    ? minutes
    : null;
}

export function validateQiniuShareUrl(value: string): {
  valid: boolean;
  insecure: boolean;
} {
  try {
    const url = new URL(value);
    return {
      valid:
        ["https:", "http:"].includes(url.protocol) &&
        Boolean(url.hostname) &&
        !url.username &&
        !url.password,
      insecure: url.protocol === "http:",
    };
  } catch {
    return { valid: false, insecure: false };
  }
}

export function validateQiniuDirectoryShareResult(
  value: unknown,
  input: QiniuDirectoryShareCreateInput,
  now = Date.now(),
): QiniuDirectoryShareResult {
  const result =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const prefix =
    typeof result.prefix === "string"
      ? normalizeQiniuSharePrefix(result.prefix)
      : null;
  if (
    !Number.isFinite(now) ||
    result.readOnly !== true ||
    result.bucketName !== input.bucketName ||
    typeof result.bucketName !== "string" ||
    prefix !== input.prefix ||
    prefix === null ||
    result.prefix !== prefix ||
    typeof result.url !== "string" ||
    !validateQiniuShareUrl(result.url).valid ||
    typeof result.extractionCode !== "string" ||
    !/^[A-Za-z0-9]{6}$/.test(result.extractionCode) ||
    typeof result.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(result.expiresAt)) ||
    Date.parse(result.expiresAt) <= now ||
    Date.parse(result.expiresAt) > now + input.durationSeconds * 1000 + 300_000
  )
    throw new Error(
      t(
        "分享结果的范围、权限、提取码或有效期无效，请重新创建。",
        "The share result has an invalid scope, permission, extraction code or expiry. Create it again.",
      ),
    );
  // Rebuild from the permitted fields; unexpected server data is never retained.
  return {
    url: result.url,
    extractionCode: result.extractionCode,
    bucketName: result.bucketName,
    prefix,
    expiresAt: result.expiresAt,
    readOnly: true,
  };
}

export function qiniuShareDisplayError(
  cause: unknown,
  fallback: string,
  sensitiveValues: readonly string[] = [],
): string {
  if (
    !(cause instanceof Error) ||
    !cause.message ||
    cause.message.length > 2000
  )
    return fallback;
  if (
    sensitiveValues.some((value) => value && cause.message.includes(value)) ||
    /https?:\/\/|[?&](?:token|access_token|extract(?:ion)?_?code)=/i.test(
      cause.message,
    )
  )
    return fallback;
  return cause.message;
}

export async function requestQiniuDirectoryShare(
  input: QiniuDirectoryShareCreateInput,
  create: QiniuDirectoryShareProps["onCreate"],
  isCurrent: () => boolean,
): Promise<QiniuDirectoryShareResult | null> {
  if (
    input.readOnly !== true ||
    !input.bucketName ||
    normalizeQiniuSharePrefix(input.prefix) !== input.prefix ||
    !Number.isInteger(input.durationSeconds) ||
    input.durationSeconds < 900 ||
    input.durationSeconds > 7200 ||
    input.durationSeconds % 60 !== 0
  )
    throw new Error(
      t(
        "目录分享请求的范围或时长无效。",
        "The directory-share request has an invalid scope or duration.",
      ),
    );
  const response = await create(input);
  if (!isCurrent()) return null;
  return validateQiniuDirectoryShareResult(response, input);
}

export function QiniuDirectoryShareResultView({
  result,
  copying,
  error,
  notice,
  onCopy,
}: {
  result: QiniuDirectoryShareResult;
  copying: boolean;
  error?: string;
  notice?: string;
  onCopy: (field: "url" | "code") => void;
}) {
  const t = useT();
  const id = useId();
  return (
    <div className="min-w-0 space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(
          "此链接只授权读取指定目录。提取码由服务端生成，请单独复制并妥善发送。",
          "This link authorizes read-only access to the specified directory. The server generated the extraction code; copy and send it separately.",
        )}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-url`}>
          {t("目录分享链接", "Directory-share URL")}
        </Label>
        <div className="flex min-w-0 gap-2">
          <Input
            id={`${id}-url`}
            type="text"
            readOnly
            value={result.url}
            className="min-w-0 flex-1 font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
            onClick={(event) => event.currentTarget.select()}
          />
          <Button
            type="button"
            variant="outline"
            disabled={copying}
            onClick={() => onCopy("url")}
          >
            {t("复制链接", "Copy URL")}
          </Button>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-code`}>
          {t("六位提取码", "Six-character extraction code")}
        </Label>
        <div className="flex min-w-0 gap-2">
          <Input
            id={`${id}-code`}
            type="text"
            readOnly
            value={result.extractionCode}
            className="min-w-0 flex-1 font-mono"
            autoComplete="off"
            spellCheck={false}
            onClick={(event) => event.currentTarget.select()}
          />
          <Button
            type="button"
            variant="outline"
            disabled={copying}
            onClick={() => onCopy("code")}
          >
            {t("复制提取码", "Copy code")}
          </Button>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("到期时间", "Expires at")}:{" "}
        {new Date(result.expiresAt).toLocaleString(intlLocale(), {
          hour12: false,
        })}
      </p>
      {validateQiniuShareUrl(result.url).insecure && (
        <p className="text-xs leading-relaxed text-warning">
          {t(
            "分享链接使用 HTTP，访问时未加密，请核对私有环境配置。",
            "The share URL uses unencrypted HTTP. Review the private-environment configuration.",
          )}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="break-words text-xs leading-relaxed text-destructive"
        >
          {localize(error)}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {localize(notice)}
        </p>
      )}
    </div>
  );
}

export function QiniuDirectoryShare({
  open,
  scopeId,
  bucketName,
  prefix,
  allowedPrefix,
  capability,
  onClose,
  onCreate,
  onCopy,
}: QiniuDirectoryShareProps) {
  const t = useT();
  const id = useId();
  const scope = JSON.stringify([
    open,
    scopeId,
    bucketName,
    prefix,
    allowedPrefix,
  ]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const generation = useRef(0);
  const requestPending = useRef(false);
  const [minutes, setMinutes] = useState("60");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{
    scope: string;
    value: QiniuDirectoryShareResult;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  useEffect(() => {
    if (!scope) return;
    generation.current++;
    requestPending.current = false;
    setMinutes("60");
    setPending(false);
    setResult(null);
    setError(null);
    setNotice(null);
    setCopying(false);
    return () => {
      generation.current++;
      requestPending.current = false;
    };
  }, [scope]);
  const visibleResult = result?.scope === scope ? result.value : null;
  useEffect(() => {
    if (!visibleResult) return;
    const expected = visibleResult.expiresAt;
    const timer = window.setTimeout(
      () => {
        if (latestScope.current !== scope) return;
        setResult(null);
        setNotice(null);
        setError(
          t(
            "目录分享已过期，请重新创建。",
            "The directory share expired. Create a new one.",
          ),
        );
      },
      Math.max(0, Date.parse(expected) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [visibleResult, scope, t]);
  const close = () => {
    generation.current++;
    requestPending.current = false;
    setResult(null);
    setError(null);
    setNotice(null);
    setCopying(false);
    setPending(false);
    onClose();
  };
  const validMinutes = parseQiniuDirectoryShareMinutes(minutes);
  const normalizedPrefix = normalizeQiniuSharePrefix(prefix);
  const withinScope = isQiniuSharePrefixAllowed(prefix, allowedPrefix);
  const create = async () => {
    if (
      !open ||
      pending ||
      requestPending.current ||
      validMinutes === null ||
      normalizedPrefix === null ||
      !withinScope ||
      !bucketName ||
      !isQiniuCapabilityAllowed(capability)
    )
      return;
    const request = ++generation.current;
    requestPending.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    const input: QiniuDirectoryShareCreateInput = {
      bucketName,
      prefix: normalizedPrefix,
      durationSeconds: validMinutes * 60,
      readOnly: true,
    };
    try {
      const response = await requestQiniuDirectoryShare(
        input,
        onCreate,
        () => request === generation.current && latestScope.current === scope,
      );
      if (!response) return;
      setResult({
        scope,
        value: response,
      });
    } catch (cause) {
      if (request === generation.current && latestScope.current === scope)
        setError(
          qiniuShareDisplayError(
            cause,
            t(
              "目录分享创建失败，请重试。",
              "Could not create the directory share. Retry.",
            ),
          ),
        );
    } finally {
      if (request === generation.current && latestScope.current === scope) {
        requestPending.current = false;
        setPending(false);
      }
    }
  };
  const copy = async (field: "url" | "code") => {
    if (
      !visibleResult ||
      copying ||
      Date.parse(visibleResult.expiresAt) <= Date.now()
    )
      return;
    const request = generation.current;
    setCopying(true);
    setError(null);
    setNotice(null);
    try {
      const value =
        field === "url" ? visibleResult.url : visibleResult.extractionCode;
      if (onCopy) await onCopy(value);
      else await navigator.clipboard.writeText(value);
      if (request === generation.current && latestScope.current === scope)
        setNotice(
          field === "url"
            ? t("链接已复制。", "URL copied.")
            : t("提取码已复制。", "Extraction code copied."),
        );
    } catch {
      if (request === generation.current && latestScope.current === scope)
        setError(
          t(
            "复制失败，请选中对应内容后手动复制。",
            "Copy failed. Select the relevant value and copy it manually.",
          ),
        );
    } finally {
      if (request === generation.current && latestScope.current === scope)
        setCopying(false);
    }
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
            {t("分享七牛目录", "Share Qiniu directory")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "只读分享不会授权修改或删除文件，也不会将账号密钥提供给接收者。",
              "Read-only sharing does not authorize modification or deletion and does not expose account keys to the recipient.",
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!visibleResult) void create();
          }}
        >
          <div className="min-w-0 space-y-3">
            <dl className="space-y-1 text-xs">
              <div className="flex min-w-0 gap-2">
                <dt className="shrink-0 text-muted-foreground">
                  {t("空间", "Bucket")}
                </dt>
                <dd className="m-0 min-w-0 break-all">{bucketName}</dd>
              </div>
              <div className="flex min-w-0 gap-2">
                <dt className="shrink-0 text-muted-foreground">
                  {t("目录范围", "Directory scope")}
                </dt>
                <dd className="m-0 min-w-0 break-all font-mono">
                  {normalizedPrefix || "/"}
                </dd>
              </div>
            </dl>
            {!withinScope && (
              <p
                role="alert"
                className="text-xs leading-relaxed text-destructive"
              >
                {t(
                  "目录超出当前授权范围或路径无效，不能创建分享。",
                  "The directory is outside the authorized scope or its path is invalid. Sharing is unavailable.",
                )}
              </p>
            )}
            <QiniuCapabilityNote capability={capability} />
            {visibleResult ? (
              <QiniuDirectoryShareResultView
                result={visibleResult}
                copying={copying}
                error={error ?? undefined}
                notice={notice ?? undefined}
                onCopy={(field) => void copy(field)}
              />
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-duration`}>
                    {t("有效时长（分钟）", "Validity (minutes)")}
                  </Label>
                  <Input
                    id={`${id}-duration`}
                    type="number"
                    min={15}
                    max={120}
                    step={1}
                    value={minutes}
                    onChange={(event) => setMinutes(event.target.value)}
                    disabled={pending}
                    aria-invalid={validMinutes === null}
                    aria-describedby={`${id}-duration-help`}
                  />
                  <p
                    id={`${id}-duration-help`}
                    className="text-xs leading-relaxed text-muted-foreground"
                  >
                    {t(
                      "默认 1 小时，可设置 15–120 分钟。六位提取码由服务端随机生成。",
                      "Defaults to 1 hour; choose 15–120 minutes. A random six-character extraction code is generated by the server.",
                    )}
                  </p>
                </div>
                {normalizedPrefix === "" && (
                  <p className="text-xs leading-relaxed text-warning">
                    {t(
                      "当前选择为空间根目录，将分享其下的全部授权文件。",
                      "The bucket root is selected; all authorized files under it will be shared.",
                    )}
                  </p>
                )}
                {error && (
                  <p
                    role="alert"
                    className="break-words text-xs leading-relaxed text-destructive"
                  >
                    {localize(error)}
                  </p>
                )}
              </>
            )}
            {pending && (
              <p
                role="status"
                className="text-xs leading-relaxed text-muted-foreground"
              >
                {t(
                  "正在创建；关闭窗口不会撤销已发送的创建请求。",
                  "Creating the share. Closing this dialog does not undo a creation request already sent.",
                )}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("关闭", "Close")}
            </Button>
            {!visibleResult && (
              <Button
                type="submit"
                disabled={
                  pending ||
                  validMinutes === null ||
                  !withinScope ||
                  !bucketName ||
                  !isQiniuCapabilityAllowed(capability)
                }
                aria-busy={pending}
              >
                {pending
                  ? t("正在创建…", "Creating…")
                  : t("创建只读分享", "Create read-only share")}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
