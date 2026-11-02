import { afterEach, expect, test } from "bun:test";
import {
  profileConnectionDetails,
  profileInformation,
} from "../src/mainview/components/profiles/profileCredentials";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";
import type { ProfileInfo } from "../src/shared/profile.types";

afterEach(() => useLocaleStore.setState({ locale: "zh-CN" }));
const base: ProfileInfo = {
  id: "fixture",
  name: "Fixture",
  provider: "qiniu",
  region: "obsolete-region",
  endpoint: "https://obsolete.invalid",
  hasR2AnalyticsToken: false,
  createdAt: "t",
  updatedAt: "t",
};
test("Qiniu public connection information describes bucket discovery rather than stale S3 fields", () => {
  useLocaleStore.setState({ locale: "en" });
  const text = profileInformation({
    ...base,
    qiniu: { mode: "public", downloadDomain: "https://download.example" },
  });
  expect(text).toContain("Public cloud");
  expect(text).toContain("UC management URL: https://uc.qbox.me");
  expect(text).toContain("Discovered per bucket");
  expect(text).toContain("Download domain: https://download.example");
  expect(text).not.toContain("obsolete");
});
test("private connection information includes each configured S3 region and safe user configuration in both languages", () => {
  const profile: ProfileInfo = {
    ...base,
    qiniu: {
      mode: "private",
      ucUrl: "https://uc.internal",
      regions: [
        { id: "region-one", s3Endpoint: "https://s3-one.internal" },
        {
          id: "region-two",
          label: "Zone two",
          s3Endpoint: "https://s3-two.internal",
        },
      ],
      downloadDomain: "https://download.internal",
      sharePortal: "https://share.internal",
      shareApiUrl: "https://share-api.internal",
      trustedCaPath: "C:/fixtures/ca.pem",
    },
  };
  for (const locale of ["zh-CN", "en"] as const) {
    useLocaleStore.setState({ locale });
    const text = profileInformation(profile);
    for (const value of [
      "https://uc.internal",
      "region-one",
      "https://s3-one.internal",
      "region-two",
      "Zone two",
      "https://s3-two.internal",
      "https://download.internal",
      "https://share.internal",
      "https://share-api.internal",
      "C:/fixtures/ca.pem",
    ])
      expect(text).toContain(value);
    expect(text).toContain(
      locale === "en" ? "Directory-share API" : "目录分享 API",
    );
    expect(text).not.toContain(locale === "en" ? "reserved" : "预留");
    expect(text).not.toContain("obsolete");
  }
});
test("non-Qiniu connection fields remain unchanged and helpers do not expose credential material", () => {
  useLocaleStore.setState({ locale: "en" });
  expect(profileConnectionDetails({ ...base, provider: "r2" })).toEqual([
    { label: "Endpoint", value: "https://obsolete.invalid" },
    { label: "Region", value: "obsolete-region" },
  ]);
  const fixture = {
    ...base,
    sessionToken: "never-copy-fixture",
    accessKeyId: "never-display-fixture",
    secretAccessKey: "never-show-fixture",
  };
  const safe = profileInformation(fixture);
  for (const value of [
    fixture.sessionToken,
    fixture.accessKeyId,
    fixture.secretAccessKey,
  ])
    expect(safe).not.toContain(value);
});
