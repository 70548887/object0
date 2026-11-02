import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { qiniuUploadBlockReason } from "../src/mainview/components/objects/qiniu-transfer-gates";
import { validateQiniuProfileConfig } from "../src/mainview/components/profiles/providerHints";
import { QiniuBucketBindings } from "../src/mainview/components/profiles/QiniuBucketBindings";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";
import {
  type Profile,
  type QiniuProfileConfig,
  toProfileInfo,
} from "../src/shared/profile.types";

afterEach(() => useLocaleStore.getState().setLocale("zh-CN"));
test("public download config matches the native transport requirements", () => {
  for (const downloadDomain of [
    "https://files.example:8443",
    "https://files.example/path",
  ]) {
    expect(
      validateQiniuProfileConfig({ mode: "public", downloadDomain }).error,
    ).toBeTruthy();
  }
  expect(
    validateQiniuProfileConfig({
      mode: "public",
      downloadDomain: "https://files.example",
    }).error,
  ).toBeNull();
  expect(
    validateQiniuProfileConfig({
      mode: "public",
      downloadDomain: "http://files.example",
    }),
  ).toEqual({ error: null, insecure: true });
});
const binding = {
  nativeName: "native-bucket",
  s3Name: "verified-server-id",
  s3RegionId: "cn-east-1",
  s3Endpoint: "https://s3.cn-east-1.qiniucs.com",
};
test("public scoped buckets require explicit identity and official HTTPS origin", () => {
  expect(
    validateQiniuProfileConfig({ mode: "public", bucketBindings: [binding] })
      .error,
  ).toBeNull();
  for (const changes of [
    { s3Name: "" },
    { nativeName: "a/b" },
    { s3RegionId: "bad/region" },
    { s3Endpoint: "http://s3.cn-east-1.qiniucs.com" },
    { s3Endpoint: "https://qiniucs.com.attacker.example" },
    { s3Endpoint: "https://s3.cn-east-1.qiniucs.com/path" },
  ]) {
    expect(
      validateQiniuProfileConfig({
        mode: "public",
        bucketBindings: [{ ...binding, ...changes }],
      }).error,
    ).toBeTruthy();
  }
});
test("private binding must match configured manual region identity and origin", () => {
  const privateBinding = {
    ...binding,
    s3RegionId: "r1",
    s3Endpoint: "https://s3.internal",
  };
  const config: QiniuProfileConfig = {
    mode: "private",
    ucUrl: "https://uc.internal",
    regions: [{ id: "r1", s3Endpoint: "https://s3.internal" }],
    bucketBindings: [privateBinding],
  };
  expect(validateQiniuProfileConfig(config).error).toBeNull();
  expect(
    validateQiniuProfileConfig({
      ...config,
      bucketBindings: [{ ...privateBinding, s3RegionId: "r2" }],
    }).error,
  ).toBeTruthy();
  expect(
    validateQiniuProfileConfig({
      ...config,
      bucketBindings: [
        { ...privateBinding, s3Endpoint: "https://other.internal" },
      ],
    }).error,
  ).toBeTruthy();
});
test("bindings reject collisions and remain plain configuration rather than credentials", () => {
  expect(
    validateQiniuProfileConfig({
      mode: "public",
      bucketBindings: [binding, { ...binding, nativeName: "other" }],
    }).error,
  ).toBeTruthy();
  const profile: Profile = {
    id: "p",
    name: "fixture",
    provider: "qiniu",
    accessKeyId: "ak-secret",
    secretAccessKey: "sk-secret",
    sessionToken: "token-secret",
    qiniu: { mode: "public", bucketBindings: [binding] },
    createdAt: "1",
    updatedAt: "1",
  };
  const info = toProfileInfo(profile);
  expect(info.qiniu?.bucketBindings?.[0]).toEqual(binding);
  for (const secret of ["ak-secret", "sk-secret", "token-secret"])
    expect(JSON.stringify(info)).not.toContain(secret);
  expect(
    qiniuUploadBlockReason({ ...info, hasSessionToken: false }),
  ).toBeTruthy();
});
test("scoped-bucket editor labels are bilingual and disclose supported boundary", () => {
  const rows = [{ ...binding, uiId: "fixture" }];
  const cn = renderToStaticMarkup(
    <QiniuBucketBindings rows={rows} onChange={() => {}} />,
  );
  expect(cn).toContain("S3 空间 ID");
  expect(cn).toContain("不能用原生空间名猜测");
  expect(cn).toContain("私有云待实机验收");
  useLocaleStore.getState().setLocale("en");
  const en = renderToStaticMarkup(
    <QiniuBucketBindings rows={rows} onChange={() => {}} />,
  );
  expect(en).toContain("S3 bucket ID");
  expect(en).toContain("Only these buckets");
  expect(en).toContain("live validation");
});
