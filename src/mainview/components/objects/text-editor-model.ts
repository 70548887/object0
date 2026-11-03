import type { Provider } from "@shared/profile.types";
import { t } from "@/lib/i18n";

export const TEXT_EDITOR_MAX_BYTES = 1024 * 1024;
export interface TextEditorScope {
  profileId: string;
  expectedProfileRevision: string;
  provider: Provider;
  bucket: string;
  prefix: string;
  profileName?: string;
}
export interface TextEditorTarget extends TextEditorScope {
  id: string;
  mode: "create" | "edit";
  key?: string;
  extension?: "txt" | "md";
}
export const isEditableTextKey = (key: string) =>
  /\.(txt|md|markdown)$/i.test(key);
function hasDisallowedControl(value: string, allowTextWhitespace = false) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      (code < 32 || (code >= 127 && code <= 159)) &&
      !(allowTextWhitespace && (code === 9 || code === 10 || code === 13))
    )
      return true;
  }
  return false;
}

export function textEditorBlockReason(provider: Provider, editing = false) {
  if (provider === "qiniu")
    return t(
      "七牛原生文本条件写入尚未验证，暂不启用新建或编辑，避免覆盖远端文件。",
      "Native Qiniu conditional text writes are not verified. Creation and editing are disabled to prevent overwrites.",
    );
  if (editing && provider !== "r2")
    return t(
      "当前仅 R2 支持保留对象属性的安全编辑；此连接可以新建文本文件。",
      "Safe editing with preserved object properties is currently available only for R2. This connection can create text files.",
    );
  return null;
}

export function validateTextName(name: string) {
  if (
    !name ||
    name.trim() !== name ||
    name === "." ||
    name === ".." ||
    /[\\/]/.test(name) ||
    hasDisallowedControl(name) ||
    /[\uD800-\uDFFF]/u.test(name) ||
    !isEditableTextKey(name) ||
    (name.startsWith(".") && !name.slice(0, name.lastIndexOf(".")).length)
  )
    return t(
      "请输入单个 TXT 或 Markdown 文件名，不含路径、控制字符或首尾空格。",
      "Enter a single TXT or Markdown filename without paths, control characters or surrounding spaces.",
    );
  return null;
}
export function validateTextContent(content: string) {
  if (/[\uD800-\uDFFF]/u.test(content) || hasDisallowedControl(content, true))
    return t(
      "仅支持有效的 UTF-8 纯文本。",
      "Only valid UTF-8 plain text is supported.",
    );
  if (new TextEncoder().encode(content).length > TEXT_EDITOR_MAX_BYTES)
    return t(
      "文本不能超过 1 MiB（按 UTF-8 字节计算）。",
      "Text must not exceed 1 MiB of UTF-8 bytes.",
    );
  return null;
}
export const usableTextEtag = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 1024 &&
  /^"[^"\r\n]+"$/.test(value);

interface TextReadResult {
  content: string;
  etag: string;
  contentType: string;
  byteLength: number;
}
interface TextWriteResult {
  etag: string | null;
  byteLength: number;
}
type TextRequest = Pick<
  TextEditorScope,
  "profileId" | "expectedProfileRevision" | "bucket"
> & { key: string };
export interface TextEditorPorts {
  confirmScope(): void;
  isScopeCurrent(): boolean;
  read(input: TextRequest): Promise<TextReadResult>;
  write(
    input: TextRequest & {
      content: string;
      expectedEtag?: string;
      createOnly: boolean;
    },
  ): Promise<TextWriteResult>;
  refresh(): void;
}
export interface TextEditorState {
  name: string;
  content: string;
  initialContent: string;
  initialName: string;
  createdKey: string | null;
  etag: string | null;
  loading: boolean;
  saving: boolean;
  loaded: boolean;
  error: string | null;
  saved: boolean;
}

/** Memory-only draft and immutable destination. UI and fixture tests share this
 * state machine; UI hints never replace the Rust conditional-write guards. */
export class TextEditorSession {
  private state: TextEditorState;
  private listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;
  constructor(
    readonly target: Readonly<TextEditorTarget>,
    private ports: TextEditorPorts,
  ) {
    const name =
      target.mode === "edit"
        ? (target.key?.split("/").pop() ?? "")
        : `untitled.${target.extension ?? "txt"}`;
    this.state = {
      name,
      initialName: name,
      content: "",
      initialContent: "",
      createdKey: null,
      etag: null,
      loading: false,
      saving: false,
      loaded: target.mode === "create",
      error: null,
      saved: false,
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(values: Partial<TextEditorState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...values };
    for (const listener of this.listeners) listener();
  }
  get dirty() {
    return (
      this.state.content !== this.state.initialContent ||
      this.state.name !== this.state.initialName
    );
  }
  get key() {
    return (
      this.state.createdKey ??
      (this.target.mode === "edit"
        ? (this.target.key ?? "")
        : `${this.target.prefix}${this.state.name}`)
    );
  }
  get createOnly() {
    return this.target.mode === "create" && !this.state.createdKey;
  }
  get needsReload() {
    return !this.createOnly && !usableTextEtag(this.state.etag);
  }
  get blockedReason() {
    return textEditorBlockReason(this.target.provider, !this.createOnly);
  }
  setName(name: string) {
    if (!this.state.loading && !this.state.saving && this.createOnly)
      this.update({ name, saved: false });
  }
  setContent(content: string) {
    if (!this.state.loading && !this.state.saving && this.state.loaded)
      this.update({ content, saved: false });
  }
  async read() {
    if (this.state.loading || this.state.saving || this.disposed) return;
    const generation = ++this.generation;
    try {
      const blocked = textEditorBlockReason(this.target.provider, true);
      if (blocked) throw new Error(blocked);
      this.ports.confirmScope();
      this.update({ loading: true, error: null });
      const result = await this.ports.read(this.request());
      if (this.disposed || generation !== this.generation) return;
      const error = validateTextContent(result.content);
      if (
        error ||
        !usableTextEtag(result.etag) ||
        !Number.isSafeInteger(result.byteLength) ||
        result.byteLength < 0 ||
        result.byteLength > TEXT_EDITOR_MAX_BYTES
      )
        throw new Error(
          error ??
            t(
              "远端未提供可靠的文本版本，不能安全编辑。",
              "Storage did not provide a reliable text version; safe editing is unavailable.",
            ),
        );
      this.update({
        content: result.content,
        initialContent: result.content,
        etag: result.etag,
        loading: false,
        loaded: true,
        saved: false,
      });
    } catch (error) {
      if (!this.disposed && generation === this.generation)
        this.update({
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : t("读取文本失败", "Failed to read text"),
        });
    }
  }
  async save() {
    if (
      this.state.loading ||
      this.state.saving ||
      !this.state.loaded ||
      this.disposed
    )
      return false;
    const generation = ++this.generation;
    try {
      if (this.blockedReason) throw new Error(this.blockedReason);
      this.ports.confirmScope();
      const validation =
        (this.createOnly ? validateTextName(this.state.name) : null) ??
        validateTextContent(this.state.content);
      if (validation) throw new Error(validation);
      if (new TextEncoder().encode(this.key).length > 1024)
        throw new Error(
          t(
            "对象路径不能超过 1024 个 UTF-8 字节。",
            "The object key must not exceed 1024 UTF-8 bytes.",
          ),
        );
      if (!this.createOnly && this.needsReload)
        throw new Error(
          t(
            "保存前请重新读取远端版本，不会无条件覆盖。",
            "Reload the remote version before saving. Unconditional overwrite is never used.",
          ),
        );
      const content = this.state.content;
      const key = this.key;
      const createOnly = this.createOnly;
      this.update({ saving: true, error: null });
      const result = await this.ports.write({
        ...this.request(),
        content,
        createOnly,
        ...(createOnly ? {} : { expectedEtag: this.state.etag as string }),
      });
      if (this.disposed || generation !== this.generation) return false;
      this.update({
        saving: false,
        initialContent: content,
        initialName: this.state.name,
        createdKey: key,
        etag: usableTextEtag(result.etag) ? result.etag : null,
        saved: true,
      });
      if (this.ports.isScopeCurrent()) this.ports.refresh();
      return true;
    } catch (error) {
      if (!this.disposed && generation === this.generation)
        this.update({
          saving: false,
          error:
            error instanceof Error
              ? error.message
              : t("保存文本失败", "Failed to save text"),
        });
      return false;
    }
  }
  private request(): TextRequest {
    return {
      profileId: this.target.profileId,
      expectedProfileRevision: this.target.expectedProfileRevision,
      bucket: this.target.bucket,
      key: this.key,
    };
  }
  activate() {
    this.disposed = false;
    this.update({ loading: false, saving: false });
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.listeners.clear();
  }
}
