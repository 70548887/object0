import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  QiniuShareLoginFields,
  requestQiniuShareSession,
} from "../src/mainview/components/qiniu/QiniuShareLogin";
import {
  isCurrentQiniuShareSessionSource,
  qiniuPrivateShareEnvironment,
  qiniuShareProfileSetFingerprint,
  qiniuShareSessionSource,
  verifyConfiguredQiniuShareSession,
} from "../src/mainview/components/qiniu/qiniu-share-scope";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";
import type {
  ProfileInfo,
  QiniuProfileConfig,
  QiniuRegionConfig,
} from "../src/shared/profile.types";
import type {
  QiniuShareLoginInput,
  QiniuShareSessionInfo,
} from "../src/shared/qiniu.types";

afterEach(() => useLocaleStore.getState().setLocale("zh-CN"));
function profile(): ProfileInfo & {
  qiniu: QiniuProfileConfig & { regions: QiniuRegionConfig[] };
} {
  return {
    id: "private",
    name: "研发私有云",
    provider: "qiniu",
    hasR2AnalyticsToken: false,
    hasSessionToken: false,
    createdAt: "t",
    updatedAt: "r1",
    qiniu: {
      mode: "private",
      ucUrl: "https://uc.internal.test",
      sharePortal: "https://portal.internal.test",
      shareApiUrl: "https://shares.internal.test",
      regions: [{ id: "private-1", s3Endpoint: "https://s3.internal.test" }],
    },
  };
}
function environmentFor(p: ProfileInfo) {
  const environment = qiniuPrivateShareEnvironment(p);
  if (!environment) throw new Error("Fixture is not a private environment");
  return environment;
}
function request(): QiniuShareLoginInput {
  return {
    url: "https://portal.internal.test/kodo-shares/verify?id=fixture&token=link-secret",
    extractionCode: "Ab12Cd",
    privateEnvironmentId: "private",
    expectedPrivateEnvironmentRevision: "r1",
  };
}
const session: QiniuShareSessionInfo = {
  sessionId: "local-session",
  bucketName: "native-bucket",
  prefix: "shared/",
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  readOnly: true,
};

describe("private share saved environment boundaries", () => {
  test("only saved private Qiniu profiles become selectable with explicit service origins", () => {
    const p = profile();
    const environment = qiniuPrivateShareEnvironment(p);
    expect(environment?.disabled).toBe(false);
    expect(environment?.revision).toBe("r1");
    expect(environment?.portalOrigin).toBe("https://portal.internal.test");
    expect(environment?.apiOrigin).toBe("https://shares.internal.test");
    expect(qiniuPrivateShareEnvironment({ ...p, provider: "r2" })).toBeNull();
    expect(
      qiniuPrivateShareEnvironment({ ...p, qiniu: { mode: "public" } }),
    ).toBeNull();
  });
  test("legacy incomplete profiles remain visible but disabled with actionable reasons", () => {
    for (const changes of [
      { shareApiUrl: undefined },
      { sharePortal: undefined },
      { regions: [] },
    ]) {
      const p = profile();
      p.qiniu = { ...p.qiniu, ...changes };
      const environment = qiniuPrivateShareEnvironment(p);
      expect(environment?.disabled).toBe(true);
      expect(environment?.reason).toBeTruthy();
    }
    const p = profile();
    p.qiniu.shareApiUrl =
      "https://user:secret@shares.internal.test/path?token=hidden";
    const environment = qiniuPrivateShareEnvironment(p);
    expect(environment?.disabled).toBe(true);
    expect(environment?.apiOrigin).toBeUndefined();
    expect(environment?.reason).not.toContain("hidden");
    expect(environment?.reason).not.toContain("secret");
    for (const origin of [
      "https://shares.internal.test/x/..",
      "https://shares.internal.test\\",
      "https://shares.internal.test/\u0009",
    ]) {
      const p = profile();
      p.qiniu.shareApiUrl = origin;
      const environment = qiniuPrivateShareEnvironment(p);
      expect(environment?.disabled).toBe(true);
      expect(environment?.apiOrigin).toBeUndefined();
    }
  });
  test("HTTP in any saved share or storage origin triggers the explicit plaintext warning", () => {
    const p = profile();
    p.qiniu.regions[0].s3Endpoint = "http://s3.internal.test:9000";
    const environment = environmentFor(p);
    expect(environment.disabled).toBe(false);
    expect(environment.insecure).toBe(true);
    const html = renderToStaticMarkup(
      <QiniuShareLoginFields
        url=""
        extractionCode=""
        privateEnvironmentId="private"
        privateEnvironments={[environment]}
        disabled={false}
        onUrlChange={() => {}}
        onCodeChange={() => {}}
        onEnvironmentChange={() => {}}
      />,
    );
    expect(html).toContain("S3 地址使用明文 HTTP");
    expect(html).toContain("待实机验收");
    expect(html).toContain("https://portal.internal.test");
    expect(html).toContain("https://shares.internal.test");
    expect(html).not.toContain("连接成功");
    expect(html.indexOf("服务环境")).toBeLessThan(html.indexOf("目录分享链接"));
    expect(html.indexOf("目录分享链接")).toBeLessThan(
      html.indexOf("六位提取码"),
    );
    const ucHttp = profile();
    ucHttp.qiniu.ucUrl = "http://uc.internal.test";
    expect(environmentFor(ucHttp).insecure).toBe(true);
  });
  test("selector shows incomplete profiles disabled and guides first-time private configuration in both languages", () => {
    const p = profile();
    p.qiniu.shareApiUrl = undefined;
    const environment = environmentFor(p);
    const fields = (environments: (typeof environment)[]) =>
      renderToStaticMarkup(
        <QiniuShareLoginFields
          url=""
          extractionCode=""
          privateEnvironmentId=""
          privateEnvironments={environments}
          disabled={false}
          onUrlChange={() => {}}
          onCodeChange={() => {}}
          onEnvironmentChange={() => {}}
        />,
      );
    expect(fields([environment])).toContain('value="private" disabled=""');
    expect(fields([environment])).toContain("分享 API");
    expect(fields([])).toContain("账号设置");
    useLocaleStore.getState().setLocale("en");
    expect(fields([environment])).toContain("Incomplete configuration");
    expect(fields([environment])).toContain("Configure a valid share portal");
    expect(fields([])).toContain("manual region");
  });
  test("request binds exact saved revision and portal, with no implicit public fallback", () => {
    const p = profile();
    const source = qiniuShareSessionSource(request(), [p]);
    expect(source.privateEnvironmentRevision).toBe("r1");
    expect(source.privateEnvironmentId).toBe("private");
    for (const changes of [
      { expectedPrivateEnvironmentRevision: undefined },
      { expectedPrivateEnvironmentRevision: "old" },
      { privateEnvironmentId: "" },
      {
        url: "https://other.internal.test/kodo-shares/verify?id=fixture&token=link-secret",
      },
      {
        url: "https://user:secret@portal.internal.test/kodo-shares/verify?id=fixture&token=link-secret",
      },
      { url: "https://portal.internal.test/other?token=link-secret" },
    ]) {
      expect(() =>
        qiniuShareSessionSource({ ...request(), ...changes }, [p]),
      ).toThrow();
    }
    expect(() =>
      qiniuShareSessionSource(
        {
          url: request().url,
          extractionCode: "Ab12Cd",
          expectedPrivateEnvironmentRevision: "stray",
        },
        [p],
      ),
    ).toThrow();
    expect(
      qiniuShareSessionSource(
        { url: request().url, extractionCode: "Ab12Cd" },
        [p],
      ).privateEnvironmentId,
    ).toBeUndefined();
  });
  test("profile roster fingerprint ignores array reordering but detects unrelated saves and config edits", () => {
    const p = profile();
    const other = {
      ...profile(),
      id: "other",
      provider: "r2" as const,
      qiniu: undefined,
    };
    expect(qiniuShareProfileSetFingerprint([p, other])).toBe(
      qiniuShareProfileSetFingerprint([other, p]),
    );
    const source = qiniuShareSessionSource(request(), [p, other]);
    expect(isCurrentQiniuShareSessionSource(source, [other, p])).toBe(true);
    expect(
      isCurrentQiniuShareSessionSource(source, [
        p,
        { ...other, updatedAt: "r2" },
      ]),
    ).toBe(false);
    const edited = profile();
    edited.qiniu.shareApiUrl = "https://different.internal.test";
    expect(isCurrentQiniuShareSessionSource(source, [edited, other])).toBe(
      false,
    );
    expect(isCurrentQiniuShareSessionSource(source, [other])).toBe(false);
    expect(
      isCurrentQiniuShareSessionSource(source, [
        { ...p, provider: "r2" },
        other,
      ]),
    ).toBe(false);
  });
  test("preflight refuses locked, stale and wrong-portal inputs before invoking RPC", async () => {
    let calls = 0;
    const verify = async () => {
      calls++;
      return session;
    };
    await expect(
      verifyConfiguredQiniuShareSession(
        request(),
        () => ({ unlocked: false, profiles: [profile()] }),
        verify,
        () => {},
      ),
    ).rejects.toThrow();
    await expect(
      verifyConfiguredQiniuShareSession(
        { ...request(), expectedPrivateEnvironmentRevision: "old" },
        () => ({ unlocked: true, profiles: [profile()] }),
        verify,
        () => {},
      ),
    ).rejects.toThrow();
    await expect(
      verifyConfiguredQiniuShareSession(
        { ...request(), url: "invalid-link-secret" },
        () => ({ unlocked: true, profiles: [profile()] }),
        verify,
        () => {},
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
  test("successful verification carries revision and returns an allowlisted session with a separate local source", async () => {
    let received: unknown;
    const result = await verifyConfiguredQiniuShareSession(
      request(),
      () => ({ unlocked: true, profiles: [profile()] }),
      async (input) => {
        received = input;
        return session;
      },
      () => {},
    );
    expect(received).toEqual(request());
    expect(result.session).toEqual(session);
    expect(Object.keys(result.session)).toHaveLength(5);
    expect(result.source.privateEnvironmentRevision).toBe("r1");
    expect(JSON.stringify(result.source)).not.toContain("link-secret");
    expect(JSON.stringify(result.source)).not.toContain("Ab12Cd");
  });
  test("late verification after an unrelated profile save or vault lock is discarded, not adopted", async () => {
    for (const lock of [false, true]) {
      let snapshot = { unlocked: true, profiles: [profile()] };
      let resolve: (value: QiniuShareSessionInfo) => void = () => {};
      const pending = new Promise<QiniuShareSessionInfo>((done) => {
        resolve = done;
      });
      const discarded: string[] = [];
      const result = verifyConfiguredQiniuShareSession(
        request(),
        () => snapshot,
        () => pending,
        (id) => {
          discarded.push(id);
        },
      );
      snapshot = lock
        ? { ...snapshot, unlocked: false }
        : { unlocked: true, profiles: [{ ...profile(), updatedAt: "r2" }] };
      resolve(session);
      await expect(result).rejects.toThrow();
      expect(discarded).toEqual([session.sessionId]);
    }
  });
  test("the outer dialog guard also rejects a private session that arrives after close", async () => {
    let current = true;
    let resolve: (value: QiniuShareSessionInfo) => void = () => {};
    const pending = new Promise<QiniuShareSessionInfo>((done) => {
      resolve = done;
    });
    const discarded: string[] = [];
    const result = requestQiniuShareSession(
      request(),
      () => pending,
      () => current,
      (id) => {
        discarded.push(id);
      },
    );
    current = false;
    resolve(session);
    expect(await result).toBeNull();
    expect(discarded).toEqual([session.sessionId]);
  });
});
