import type {
  UpdateChannel,
  UpdateCheckResult,
  UpdateInfo,
  UpdateSnapshot,
} from "@shared/updater.types";
import { t } from "@/lib/i18n";

export const UPDATE_REPOSITORY = "70548887/object0";
export function safeUpdatePage(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password &&
      (url.pathname === `/${UPDATE_REPOSITORY}/releases` ||
        url.pathname.startsWith(`/${UPDATE_REPOSITORY}/releases/`))
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export interface UpdatePorts {
  info(): Promise<UpdateInfo>;
  check(channel: UpdateChannel): Promise<UpdateCheckResult>;
  download(releaseId: string): Promise<UpdateSnapshot>;
  cancel(releaseId: string): Promise<UpdateSnapshot>;
  apply(releaseId: string): Promise<{ accepted: boolean }>;
  exitBlockers(): string[];
  rememberChannel(channel: UpdateChannel): void;
}
export interface UpdateSessionState {
  channel: UpdateChannel;
  info: UpdateInfo | null;
  infoLoading: boolean;
  checking: boolean;
  result: UpdateCheckResult | null;
  snapshot: UpdateSnapshot | null;
  error: string | null;
  applying: boolean;
}
const activeStage = (value: UpdateSnapshot | null) =>
  value?.stage === "downloading" ||
  value?.stage === "verifying" ||
  value?.stage === "installing";

/** UI state never authorizes installation: Rust independently pins the release,
 * verifies signatures and checks native task/installation admission guards. */
export class UpdateSession {
  private state: UpdateSessionState;
  private listeners = new Set<() => void>();
  private generation = 0;
  private infoGeneration = 0;
  private acceptProgress = false;
  private minimumAttempt = 0;
  private highestSeenAttempt = 0;
  private acknowledgedDownload: { releaseId: string; attempt: number } | null =
    null;
  constructor(
    private ports: UpdatePorts,
    channel: UpdateChannel = "stable",
  ) {
    this.state = {
      channel,
      info: null,
      infoLoading: false,
      checking: false,
      result: null,
      snapshot: null,
      error: null,
      applying: false,
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(change: Partial<UpdateSessionState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
  get busy() {
    return (
      this.state.checking ||
      this.state.applying ||
      activeStage(this.state.snapshot)
    );
  }
  get release() {
    return this.state.result?.release ?? null;
  }
  get ready() {
    return (
      !!this.release &&
      this.state.snapshot?.releaseId === this.release.id &&
      this.state.snapshot.stage === "ready" &&
      this.acknowledgedDownload?.releaseId === this.release.id &&
      this.acknowledgedDownload.attempt === this.state.snapshot.attempt
    );
  }
  get downloadAllowed() {
    const { info } = this.state;
    const release = this.release;
    return (
      !!release?.canDownload &&
      !!info?.signingConfigured &&
      info.packageKind !== "unknown" &&
      release.packageKind === info.packageKind
    );
  }
  async loadInfo() {
    if (this.state.infoLoading) return;
    const generation = ++this.infoGeneration;
    this.update({ infoLoading: true });
    try {
      const info = await this.ports.info();
      if (generation !== this.infoGeneration) return;
      if (info.repository !== UPDATE_REPOSITORY || !info.currentVersion)
        throw new Error(
          t(
            "更新源身份或版本信息无效",
            "Invalid update repository or version information",
          ),
        );
      this.update({ info, infoLoading: false });
    } catch (error) {
      if (generation === this.infoGeneration)
        this.update({ infoLoading: false, error: message(error) });
    }
  }
  async changeChannel(channel: UpdateChannel) {
    if (channel === this.state.channel || this.state.applying) return;
    const old = this.release;
    const generation = ++this.generation;
    this.acceptProgress = false;
    this.acknowledgedDownload = null;
    const hadDownload = activeStage(this.state.snapshot);
    if (old && hadDownload) {
      try {
        const cancelled = await this.ports.cancel(old.id);
        this.highestSeenAttempt = Math.max(
          this.highestSeenAttempt,
          cancelled.attempt,
        );
      } catch (error) {
        if (generation === this.generation) {
          this.failUnconfirmedCancellation(old.id, error);
        }
        return;
      }
      if (generation !== this.generation) return;
    }
    this.ports.rememberChannel(channel);
    this.update({
      channel,
      result: null,
      snapshot: null,
      checking: false,
      error: null,
    });
  }
  async check() {
    if (this.busy) return;
    const generation = ++this.generation;
    ++this.infoGeneration;
    const channel = this.state.channel;
    this.acceptProgress = false;
    this.acknowledgedDownload = null;
    this.update({
      infoLoading: false,
      checking: true,
      result: null,
      snapshot: null,
      error: null,
    });
    try {
      const result = await this.ports.check(channel);
      if (generation !== this.generation || channel !== this.state.channel)
        return;
      if (
        result.channel !== channel ||
        result.info.repository !== UPDATE_REPOSITORY ||
        !result.info.currentVersion ||
        !result.checkedAt
      )
        throw new Error(
          t(
            "更新检测返回了不匹配的结果，请重试",
            "Update check returned a mismatched result; retry",
          ),
        );
      this.update({ info: result.info, result, checking: false });
    } catch (error) {
      if (generation === this.generation)
        this.update({ checking: false, result: null, error: message(error) });
    }
  }
  progress = (snapshot: UpdateSnapshot) => {
    if (
      !this.acceptProgress ||
      snapshot.releaseId !== this.release?.id ||
      !Number.isSafeInteger(snapshot.attempt) ||
      snapshot.attempt < this.minimumAttempt ||
      !Number.isFinite(snapshot.downloaded) ||
      snapshot.downloaded < 0 ||
      (snapshot.total !== null &&
        (!Number.isFinite(snapshot.total) || snapshot.total < 0))
    )
      return;
    if (snapshot.attempt < (this.state.snapshot?.attempt ?? 0)) return;
    this.minimumAttempt = snapshot.attempt;
    this.highestSeenAttempt = Math.max(
      this.highestSeenAttempt,
      snapshot.attempt,
    );
    // Events can arrive before their download RPC completes. Only that RPC's
    // successful response may acknowledge this attempt as installable.
    const waitingForAcknowledgement =
      snapshot.stage === "ready" &&
      (this.acknowledgedDownload?.releaseId !== snapshot.releaseId ||
        this.acknowledgedDownload.attempt !== snapshot.attempt);
    this.update({
      snapshot: {
        ...snapshot,
        stage: waitingForAcknowledgement ? "verifying" : snapshot.stage,
      },
      error:
        snapshot.stage === "failed"
          ? (snapshot.error ??
            t("更新下载或验证失败", "Update download or verification failed"))
          : this.state.error,
    });
    if (
      snapshot.stage === "cancelled" ||
      snapshot.stage === "failed" ||
      (snapshot.stage === "ready" && !waitingForAcknowledgement)
    )
      this.acceptProgress = false;
  };
  async download() {
    if (this.busy || !this.downloadAllowed || !this.release || this.ready)
      return;
    const generation = ++this.generation;
    const releaseId = this.release.id;
    this.minimumAttempt = this.highestSeenAttempt + 1;
    this.acknowledgedDownload = null;
    this.acceptProgress = true;
    this.update({
      error: null,
      snapshot: {
        releaseId,
        attempt: this.minimumAttempt,
        stage: "downloading",
        downloaded: 0,
        total: this.release.size,
        error: null,
      },
    });
    try {
      const result = await this.ports.download(releaseId);
      if (Number.isSafeInteger(result.attempt) && result.attempt >= 0)
        this.highestSeenAttempt = Math.max(
          this.highestSeenAttempt,
          result.attempt,
        );
      if (generation !== this.generation || releaseId !== this.release?.id)
        return;
      if (
        result.releaseId !== releaseId ||
        !Number.isSafeInteger(result.attempt) ||
        result.attempt < 0 ||
        !Number.isFinite(result.downloaded) ||
        result.downloaded < 0 ||
        (result.total !== null &&
          (!Number.isFinite(result.total) || result.total < 0))
      )
        throw new Error(
          t(
            "下载返回的更新身份不匹配，请重新检查。",
            "The downloaded update identity does not match. Check again.",
          ),
        );
      if (result.stage === "ready" && !result.error) {
        // The current RPC can explicitly reuse a verified immutable cached
        // descriptor. Unlike an event, it is bound to this generation/call.
        this.minimumAttempt = result.attempt;
        this.acknowledgedDownload = { releaseId, attempt: result.attempt };
        this.acceptProgress = false;
        this.update({ snapshot: { ...result }, error: null });
        return;
      }
      this.progress(result);
    } catch (error) {
      if (generation === this.generation) {
        this.acceptProgress = false;
        this.update({
          error: message(error),
          snapshot: {
            releaseId,
            attempt: this.minimumAttempt,
            stage: "failed",
            downloaded: this.state.snapshot?.downloaded ?? 0,
            total: this.state.snapshot?.total ?? null,
            error: message(error),
          },
        });
      }
    }
  }
  async cancel() {
    const releaseId = this.release?.id;
    if (!releaseId || !activeStage(this.state.snapshot) || this.state.applying)
      return;
    ++this.generation;
    this.acceptProgress = false;
    this.acknowledgedDownload = null;
    const generation = this.generation;
    this.update({
      snapshot: {
        releaseId,
        attempt: this.minimumAttempt,
        stage: "cancelled",
        downloaded: this.state.snapshot?.downloaded ?? 0,
        total: this.state.snapshot?.total ?? null,
        error: null,
      },
      error: null,
    });
    try {
      const cancelled = await this.ports.cancel(releaseId);
      this.highestSeenAttempt = Math.max(
        this.highestSeenAttempt,
        cancelled.attempt,
      );
    } catch (error) {
      if (generation === this.generation) {
        this.failUnconfirmedCancellation(releaseId, error);
      }
    }
  }
  private failUnconfirmedCancellation(releaseId: string, error: unknown) {
    // Cancellation invalidated the original download generation. Restoring an
    // active snapshot would leave it without an RPC that can acknowledge ready
    // (e.g. Rust finished just before cancel and rejected cancellation as stale).
    // Fail closed, retain the selected release, and let the user explicitly
    // check/retry. Neither late events nor the invalidated RPC authorize install.
    this.acceptProgress = false;
    this.acknowledgedDownload = null;
    const reason = `${t(
      "无法确认取消结果，请重新检查更新或重试下载。",
      "Cancellation could not be confirmed. Check for updates or retry the download.",
    )}\n${message(error)}`;
    this.update({
      error: reason,
      snapshot: {
        releaseId,
        attempt: this.state.snapshot?.attempt ?? this.minimumAttempt,
        stage: "failed",
        downloaded: this.state.snapshot?.downloaded ?? 0,
        total: this.state.snapshot?.total ?? null,
        error: reason,
      },
    });
  }
  blockers() {
    return this.ports.exitBlockers();
  }
  async apply() {
    if (!this.ready || this.state.applying || !this.release) return false;
    const blockers = this.blockers();
    if (blockers.length) {
      this.update({ error: blockers.join("\n") });
      return false;
    }
    const releaseId = this.release.id;
    const generation = ++this.generation;
    this.acceptProgress = false;
    this.update({ applying: true, error: null });
    let submitted = false;
    try {
      // Recheck immediately before IPC; a task/draft may appear since the user
      // first opened the confirmation section.
      const latest = this.blockers();
      if (latest.length) throw new Error(latest.join("\n"));
      submitted = true;
      const result = await this.ports.apply(releaseId);
      if (generation !== this.generation || releaseId !== this.release?.id)
        return false;
      if (!result.accepted)
        throw new Error(
          t(
            "更新安装未被接受，当前程序保持不变",
            "Update installation was not accepted; the current program is unchanged",
          ),
        );
      this.update({
        snapshot: this.state.snapshot
          ? { ...this.state.snapshot, stage: "installing" }
          : null,
      });
      return true;
    } catch (error) {
      if (generation === this.generation) {
        if (submitted) this.acknowledgedDownload = null;
        this.update({
          applying: false,
          error: message(error),
          ...(submitted && this.state.snapshot
            ? {
                snapshot: {
                  ...this.state.snapshot,
                  stage: "failed",
                  error: message(error),
                },
              }
            : {}),
        });
      }
      return false;
    }
  }
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : t("更新操作失败，请重试", "Update operation failed; retry");
}
