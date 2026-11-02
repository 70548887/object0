import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  canAttemptQiniuBucketAction,
  canConfirmQiniuBucketRemoval,
  QiniuBucketActions,
} from "../src/mainview/components/qiniu/QiniuBucketActions";
import {
  classifyQiniuBucketEmptiness,
  classifyQiniuBucketFailure,
  createQiniuBucketPanelController,
  type QiniuBucketPanelRPC,
  type QiniuBucketPanelState,
} from "../src/mainview/components/qiniu/QiniuBucketPanel";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";
import type {
  QiniuBucketContext,
  QiniuRegionInfo,
} from "../src/shared/qiniu.types";
import type { ObjectListRes } from "../src/shared/s3.types";

const region: QiniuRegionInfo = {
  kodoRegionId: "z0",
  s3RegionId: "cn-east-1",
  label: "Fixture region",
  s3Urls: ["https://s3.cn-east-1.qiniucs.com"],
  rsUrls: ["https://rs.qbox.me"],
  storageClasses: [],
  expiresAt: 9999999999,
};
const context: QiniuBucketContext = {
  bucket: { name: "fixture-bucket", remark: "old remark" },
  region,
  s3BucketName: "fixture-alias",
  backendMode: "kodo",
};
const empty: ObjectListRes = { objects: [], prefixes: [], isTruncated: false };
function fixture(
  overrides: {
    context?: QiniuBucketContext;
    page?: ObjectListRes;
    fail?: (method: string) => unknown;
    privateVerified?: boolean;
  } = {},
) {
  const calls: { method: string; input: unknown }[] = [];
  const states: QiniuBucketPanelState[] = [];
  const refreshes: string[] = [];
  const removals: [string, string][] = [];
  let current = true;
  const call = (async (method: string, input: unknown) => {
    calls.push({ method, input });
    const error = overrides.fail?.(method);
    if (error) throw error;
    if (method === "qiniu:regions") return [region];
    if (method === "qiniu:bucket-context") return overrides.context ?? context;
    if (method === "objects:list") return overrides.page ?? empty;
    if (method === "qiniu:bucket-create")
      return {
        name: (input as { name: string }).name,
        privateVerified: overrides.privateVerified ?? true,
      };
    return undefined;
  }) as QiniuBucketPanelRPC;
  const controller = createQiniuBucketPanelController({
    scopeId: "fixture-scope",
    profileId: "fixture-profile",
    bucketName: "fixture-bucket",
    call,
    isCurrent: () => current,
    onState: (state) => states.push(state),
    refreshBuckets: async (id) => {
      refreshes.push(id);
    },
    onRemoved: (id, bucket) => {
      removals.push([id, bucket]);
    },
  });
  return {
    controller,
    calls,
    states,
    refreshes,
    removals,
    setCurrent: (value: boolean) => {
      current = value;
    },
  };
}

describe("Qiniu bucket management RPC orchestration", () => {
  test("loads native regions and whole-root emptiness without claiming write authorization", async () => {
    const value = fixture();
    await value.controller.load();
    const state = value.controller.getState();
    expect(state.regions).toEqual([
      { id: "cn-east-1", label: "Fixture region" },
    ]);
    expect(state.emptyState).toBe("empty");
    expect(state.capabilities.create.state).toBe("unknown");
    expect(state.capabilities.remove.state).toBe("unknown");
    expect(
      value.calls.find((entry) => entry.method === "objects:list")?.input,
    ).toEqual({
      profileId: "fixture-profile",
      bucket: "fixture-bucket",
      prefix: "",
      maxKeys: 1,
    });
  });
  test("unknown write permission requires an explicit attempt policy; denied states never qualify", () => {
    expect(canAttemptQiniuBucketAction({ state: "unknown" })).toBe(false);
    expect(canAttemptQiniuBucketAction({ state: "unknown" }, true)).toBe(true);
    for (const state of ["forbidden", "unsupported", "unavailable"] as const)
      expect(canAttemptQiniuBucketAction({ state }, true)).toBe(false);
    expect(
      canConfirmQiniuBucketRemoval({
        bucketName: "fixture-bucket",
        confirmation: "fixture-bucket",
        emptyState: "empty",
        capability: { state: "unknown" },
        allowUnverifiedAttempt: true,
      }),
    ).toBe(true);
    expect(
      canConfirmQiniuBucketRemoval({
        bucketName: "fixture-bucket",
        confirmation: "fixture-bucket ",
        emptyState: "empty",
        capability: { state: "unknown" },
        allowUnverifiedAttempt: true,
      }),
    ).toBe(false);
  });
  test("does not call delete for nonempty or incomplete pages", async () => {
    for (const page of [
      { ...empty, prefixes: [{ prefix: "folder/" }] },
      { ...empty, isTruncated: true, nextCursor: "opaque" },
    ]) {
      const value = fixture({ page });
      await value.controller.load();
      await expect(
        value.controller.remove({ bucketName: "fixture-bucket" }),
      ).rejects.toThrow();
      expect(
        value.calls.some((entry) => entry.method === "qiniu:bucket-delete"),
      ).toBe(false);
    }
  });
  test("deletes only the exact selected empty bucket and sends server confirmation", async () => {
    const value = fixture();
    await value.controller.load();
    await expect(
      value.controller.remove({ bucketName: "different-bucket" }),
    ).rejects.toThrow();
    await value.controller.remove({ bucketName: "fixture-bucket" });
    expect(
      value.calls.find((entry) => entry.method === "qiniu:bucket-delete")
        ?.input,
    ).toEqual({
      profileId: "fixture-profile",
      bucket: "fixture-bucket",
      confirmName: "fixture-bucket",
    });
    expect(value.refreshes).toEqual(["fixture-profile"]);
    expect(value.removals).toEqual([["fixture-profile", "fixture-bucket"]]);
  });
  test("supports private creation only and requires verified privacy before success", async () => {
    const value = fixture();
    await value.controller.load();
    await expect(
      value.controller.create({
        name: "new-fixture",
        regionId: "cn-east-1",
        access: "public" as "private",
      }),
    ).rejects.toThrow();
    expect(
      value.calls.some((entry) => entry.method === "qiniu:bucket-create"),
    ).toBe(false);
    await value.controller.create({
      name: "new-fixture",
      regionId: "cn-east-1",
      access: "private",
    });
    expect(
      value.calls.find((entry) => entry.method === "qiniu:bucket-create")
        ?.input,
    ).toEqual({
      profileId: "fixture-profile",
      name: "new-fixture",
      regionId: "cn-east-1",
      access: "private",
    });
    expect(value.controller.getState().notice).toEqual({
      action: "create",
      name: "new-fixture",
    });
    const unsafe = fixture({ privateVerified: false });
    await unsafe.controller.load();
    await expect(
      unsafe.controller.create({
        name: "unverified-bucket",
        regionId: "cn-east-1",
        access: "private",
      }),
    ).rejects.toThrow();
    expect(unsafe.controller.getState().notice).toBe(null);
    expect(unsafe.refreshes).toEqual([]);
  });
  test("read-only or S3-only contexts cannot attempt native management writes", async () => {
    const readonly = fixture({
      context: {
        ...context,
        bucket: { ...context.bucket, permission: "readonly" },
      },
    });
    await readonly.controller.load();
    expect(readonly.controller.getState().capabilities.remark.state).toBe(
      "forbidden",
    );
    await expect(
      readonly.controller.updateRemark({
        bucketName: "fixture-bucket",
        remark: "new",
      }),
    ).rejects.toThrow();
    const s3 = fixture({ context: { ...context, backendMode: "s3" } });
    await s3.controller.load();
    expect(s3.controller.getState().capabilities.remove.state).toBe(
      "unsupported",
    );
    await expect(
      s3.controller.remove({ bucketName: "fixture-bucket" }),
    ).rejects.toThrow();
  });
  test("creation sends the S3 region alias rather than the distinct native region ID", async () => {
    const value = fixture();
    await value.controller.load();
    await expect(
      value.controller.create({
        name: "native-id-invalid",
        regionId: "z0",
        access: "private",
      }),
    ).rejects.toThrow();
    expect(
      value.calls.some((entry) => entry.method === "qiniu:bucket-create"),
    ).toBe(false);
    await value.controller.create({
      name: "s3-id-correct",
      regionId: "cn-east-1",
      access: "private",
    });
    expect(
      value.calls.find((entry) => entry.method === "qiniu:bucket-create")
        ?.input,
    ).toMatchObject({ regionId: "cn-east-1", access: "private" });
  });
  test("server refusal is preserved and does not become permission success", async () => {
    const value = fixture({
      fail: (method) =>
        method === "qiniu:bucket-remark"
          ? new Error("Qiniu permission denied [permission-denied] (HTTP 403)")
          : null,
    });
    await value.controller.load();
    await expect(
      value.controller.updateRemark({
        bucketName: "fixture-bucket",
        remark: "new",
      }),
    ).rejects.toThrow();
    expect(value.controller.getState().capabilities.remark.state).toBe(
      "forbidden",
    );
    expect(value.controller.getState().notice).toBe(null);
    expect(value.refreshes).toEqual([]);
  });
  test("distinguishes unsupported, forbidden, connection failure and incomplete empty state", () => {
    expect(classifyQiniuBucketFailure(new Error("HTTP 404")).state).toBe(
      "unsupported",
    );
    expect(classifyQiniuBucketFailure(new Error("HTTP 401")).state).toBe(
      "forbidden",
    );
    expect(classifyQiniuBucketFailure(new Error("TLS failed")).state).toBe(
      "unavailable",
    );
    expect(classifyQiniuBucketEmptiness({ ...empty, isTruncated: true })).toBe(
      "unknown",
    );
  });
  test("stale loads cannot replace the newly selected scope", async () => {
    const pending: ((result: unknown) => void)[] = [];
    const states: QiniuBucketPanelState[] = [];
    let current = true;
    const call = ((_method: string) =>
      new Promise((resolve) => pending.push(resolve))) as QiniuBucketPanelRPC;
    const controller = createQiniuBucketPanelController({
      scopeId: "old-scope",
      profileId: "old-profile",
      bucketName: "fixture-bucket",
      call,
      isCurrent: () => current,
      onState: (state) => states.push(state),
      refreshBuckets: async () => {},
    });
    const loading = controller.load();
    expect(states.length).toBe(1);
    current = false;
    controller.dispose();
    pending[0]([region]);
    pending[1](context);
    pending[2](empty);
    await loading;
    expect(states.length).toBe(1);
    expect(states[0].context).toBe(null);
  });
  test("late completed mutations do not refresh or remove the new account selection", async () => {
    let finish: ((value: undefined) => void) | undefined;
    let current = true;
    const refreshes: string[] = [];
    const removals: string[] = [];
    const call = (async (method: string) =>
      method === "qiniu:regions"
        ? [region]
        : method === "qiniu:bucket-context"
          ? context
          : method === "objects:list"
            ? empty
            : new Promise((resolve) => {
                finish = resolve;
              })) as QiniuBucketPanelRPC;
    const controller = createQiniuBucketPanelController({
      scopeId: "old",
      profileId: "old-profile",
      bucketName: "fixture-bucket",
      call,
      isCurrent: () => current,
      onState: () => {},
      refreshBuckets: async (id) => {
        refreshes.push(id);
      },
      onRemoved: (_id, name) => {
        removals.push(name);
      },
    });
    await controller.load();
    const operation = controller.remove({ bucketName: "fixture-bucket" });
    expect(controller.getState().pending).toBe(true);
    current = false;
    finish?.(undefined);
    await operation;
    expect(refreshes).toEqual([]);
    expect(removals).toEqual([]);
    expect(controller.getState().pending).toBe(false);
  });
  test("effect cleanup and replay reactivate the controller without accepting the old read", async () => {
    const pending: ((value: unknown) => void)[] = [];
    const call = ((_method: string) =>
      new Promise((resolve) => pending.push(resolve))) as QiniuBucketPanelRPC;
    const controller = createQiniuBucketPanelController({
      scopeId: "same-scope",
      profileId: "fixture-profile",
      bucketName: "fixture-bucket",
      call,
      isCurrent: () => true,
      onState: () => {},
      refreshBuckets: async () => {},
    });
    const oldRead = controller.load();
    controller.dispose();
    controller.activate();
    const newRead = controller.load();
    expect(pending.length).toBe(6);
    pending[3]([region]);
    pending[4](context);
    pending[5](empty);
    await newRead;
    expect(controller.getState().loading).toBe(false);
    expect(controller.getState().emptyState).toBe("empty");
    pending[0]([]);
    pending[1]({ ...context, bucket: { name: "stale-bucket" } });
    pending[2]({ ...empty, isTruncated: true });
    await oldRead;
    expect(controller.getState().context?.bucket.name).toBe("fixture-bucket");
    expect(controller.getState().regions).toHaveLength(1);
    expect(controller.getState().emptyState).toBe("empty");
  });
  test("remarks enforce server's 100 Unicode character bound", async () => {
    const value = fixture();
    await value.controller.load();
    await expect(
      value.controller.updateRemark({
        bucketName: "fixture-bucket",
        remark: "😀".repeat(101),
      }),
    ).rejects.toThrow();
    expect(
      value.calls.some((entry) => entry.method === "qiniu:bucket-remark"),
    ).toBe(false);
    await value.controller.updateRemark({
      bucketName: "fixture-bucket",
      remark: "😀".repeat(100),
    });
    expect(value.refreshes).toEqual(["fixture-profile"]);
  });
  test("SSR retains explicit unverified permissions in both languages", () => {
    const render = () =>
      renderToStaticMarkup(
        <QiniuBucketActions
          scopeId="fixture"
          bucketName="fixture-bucket"
          regions={[{ id: "z0", label: "Fixture region" }]}
          emptyState="empty"
          capabilities={{
            create: { state: "unknown" },
            remove: { state: "unknown" },
            remark: { state: "unknown" },
          }}
          allowUnverifiedAttempt
          onCreate={async () => {}}
          onRemove={async () => {}}
          onUpdateRemark={async () => {}}
        />,
      );
    useLocaleStore.getState().setLocale("en");
    const en = render();
    expect(en).toContain("Create bucket");
    expect(en).toContain("not confirmed");
    useLocaleStore.getState().setLocale("zh-CN");
    const zh = render();
    expect(zh).toContain("创建空间");
    expect(zh).toContain("能力尚未确认");
  });
});
