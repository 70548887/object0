import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type ConnectionCheck,
  connectionCheckMessage,
  connectionTestPresentation,
  type ProfileSaveRequirements,
  profileSaveBlockers,
} from "../src/mainview/components/profiles/connection-test-feedback";
import { ProfileConnectionFeedback } from "../src/mainview/components/profiles/ProfileForm";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";

afterEach(() => useLocaleStore.getState().setLocale("zh-CN"));

function screenshotChecks(): ConnectionCheck[] {
  return [
    { name: "authentication", status: "ok" },
    {
      name: "bucketAccess",
      status: "warning",
      message:
        "尚未选择空间，未验证对象列表权限 / No bucket selected; object listing permission is unverified",
    },
    { name: "regionDiscovery", status: "ok" },
    {
      name: "downloadDomain",
      status: "warning",
      message:
        "未配置自定义下载域名；默认域名可能受文件类型限制 / No custom download domain; default domain restrictions may apply",
    },
  ];
}
function saveInput(
  overrides: Partial<ProfileSaveRequirements> = {},
): ProfileSaveRequirements {
  return {
    saving: false,
    name: "Fixture",
    provider: "qiniu",
    needsQiniuMigration: true,
    backupAcknowledged: false,
    needsMigrationRecoveryKey: true,
    recoveryKeyProvided: false,
    isEditing: false,
    accessKeyProvided: true,
    secretKeyProvided: true,
    ...overrides,
  };
}

describe("connection test presentation", () => {
  test("the unselected-bucket fixture matches the real native diagnostic", () => {
    const nativeSource = readFileSync("src-tauri/src/qiniu/client.rs", "utf8");
    expect(nativeSource).toContain(
      screenshotChecks()[1].message ?? "unreachable",
    );
    expect(connectionCheckMessage(screenshotChecks()[1])).not.toContain(
      "No bucket selected",
    );
  });
  test("the reported screenshot is amber partial, never a red failure or full success", () => {
    const feedback = connectionTestPresentation("qiniu", {
      success: false,
      bucketCount: 2,
      error: "连接尚未完整验证",
      checks: screenshotChecks(),
    });
    expect(feedback.ok).toBe(false);
    expect(feedback.tone).toBe("warning");
    expect(feedback.msg).toContain("账号认证已通过");
    expect(feedback.msg).toContain("空间读取尚未验证");
    expect(feedback.msg).toContain("保存条件");
    const html = renderToStaticMarkup(
      <ProfileConnectionFeedback provider="qiniu" result={feedback} />,
    );
    expect(html).toContain("border-warning/30");
    expect(html).not.toContain("border-destructive/30");
    expect(html).toContain("下载域名（可选）");
    expect(html).toContain("尚未验证");
    expect(html).not.toContain("No bucket selected");
  });

  test.each([
    "authentication",
    "bucketAccess",
    "regionDiscovery",
  ] as const)("a real %s error remains red", (name) => {
    const checks = screenshotChecks().map((item) =>
      item.name === name ? { ...item, status: "error" as const } : item,
    );
    const feedback = connectionTestPresentation("qiniu", {
      success: false,
      bucketCount: 0,
      error: "固定安全诊断",
      checks,
    });
    expect(feedback.tone).toBe("error");
    expect(feedback.msg).toBe("固定安全诊断");
    expect(
      renderToStaticMarkup(
        <ProfileConnectionFeedback provider="qiniu" result={feedback} />,
      ),
    ).toContain("border-destructive/30");
  });

  test("optional domain warning does not downgrade verified account and bucket reads", () => {
    const checks = screenshotChecks().map((item) =>
      item.name === "bucketAccess" ? { ...item, status: "ok" as const } : item,
    );
    const feedback = connectionTestPresentation("qiniu", {
      success: true,
      bucketCount: 3,
      checks,
    });
    expect(feedback.tone).toBe("success");
    expect(feedback.ok).toBe(true);
    expect(feedback.msg).toContain("空间读取验证通过");
    expect(feedback.msg).toContain("下载域名能力单独验证");
  });

  test("unsupported or missing critical capabilities never become a full success", () => {
    const checks = screenshotChecks().map((item) =>
      item.name === "bucketAccess"
        ? { ...item, status: "unsupported" as const }
        : item,
    );
    expect(
      connectionTestPresentation("qiniu", {
        success: false,
        bucketCount: 1,
        checks,
      }).tone,
    ).toBe("warning");
    expect(
      connectionTestPresentation("qiniu", {
        success: true,
        bucketCount: 1,
        checks: checks.filter((item) => item.name !== "authentication"),
      }).tone,
    ).toBe("error");
  });

  test("ordinary R2 and S3 reports keep existing success/failure behavior", () => {
    for (const provider of ["r2", "aws", "custom"]) {
      expect(
        connectionTestPresentation(provider, { success: true, bucketCount: 2 })
          .tone,
      ).toBe("success");
      expect(
        connectionTestPresentation(provider, {
          success: false,
          bucketCount: 0,
          error: "permission denied fixture",
        }).msg,
      ).toBe("permission denied fixture");
    }
  });

  test("both form feedback and saved-account tests use the same presentation helper", () => {
    for (const name of ["ProfileForm.tsx", "ProfileList.tsx"]) {
      expect(
        readFileSync(`src/mainview/components/profiles/${name}`, "utf8"),
      ).toContain("connectionTestPresentation(");
    }
    expect(
      readFileSync("src/mainview/components/profiles/ProfileList.tsx", "utf8"),
    ).toContain("toast.warning(");
  });

  test("partial verification is explained in English without changing the native result", () => {
    useLocaleStore.getState().setLocale("en");
    const feedback = connectionTestPresentation("qiniu", {
      success: false,
      bucketCount: 0,
      checks: screenshotChecks(),
    });
    expect(feedback.ok).toBe(false);
    expect(feedback.msg).toContain("Account authentication passed");
    expect(
      renderToStaticMarkup(
        <ProfileConnectionFeedback provider="qiniu" result={feedback} />,
      ),
    ).toContain("Download domain (optional)");
    expect(connectionCheckMessage(screenshotChecks()[1])).not.toContain(
      "尚未选择空间",
    );
  });

  test("unknown provider diagnostics retain their literal text, including slash-separated content", () => {
    const message = "provider-key/path / https://fixture.example/object";
    expect(
      connectionCheckMessage({
        name: "bucketAccess",
        status: "error",
        message,
      }),
    ).toBe(message);
  });
});

describe("save requirements do not bypass vault migration", () => {
  test("the screenshot's disabled Save explains both migration blockers", () => {
    const reasons = profileSaveBlockers(saveInput());
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain("勾选");
    expect(reasons[1]).toContain("云仓密码库");
    expect(reasons[1]).toContain("不是七牛 SecretKey");
    expect(reasons[1]).toContain("不要");
  });

  test("acknowledgement and recovery verification remain separate prerequisites", () => {
    expect(
      profileSaveBlockers(saveInput({ backupAcknowledged: true })),
    ).toHaveLength(1);
    expect(
      profileSaveBlockers(saveInput({ recoveryKeyProvided: true })),
    ).toHaveLength(1);
    expect(
      profileSaveBlockers(
        saveInput({ backupAcknowledged: true, recoveryKeyProvided: true }),
      ),
    ).toEqual([]);
  });

  test("credentials, name, configuration errors and saving remain blockers", () => {
    const clean = saveInput({
      needsQiniuMigration: false,
      needsMigrationRecoveryKey: false,
    });
    expect(
      profileSaveBlockers({ ...clean, accessKeyProvided: false }),
    ).toHaveLength(1);
    expect(profileSaveBlockers({ ...clean, name: " " })).toHaveLength(1);
    expect(
      profileSaveBlockers({
        ...clean,
        qiniuValidationError: "Invalid origin fixture",
      }),
    ).toEqual(["Invalid origin fixture"]);
    expect(profileSaveBlockers({ ...clean, saving: true })).toHaveLength(1);
  });

  test("a new account can be saved without a full connection test once save prerequisites are met", () => {
    // No success flag, bucket name or download domain is part of these rules.
    expect(
      profileSaveBlockers(
        saveInput({
          needsQiniuMigration: false,
          needsMigrationRecoveryKey: false,
        }),
      ),
    ).toEqual([]);
    const source = readFileSync(
      "src/mainview/components/profiles/ProfileForm.tsx",
      "utf8",
    );
    expect(source).toMatch(/aria-describedby=\{\s*saveBlockers\.length > 0/);
    expect(source).not.toContain("disabled={!testResult");
    expect(source).toContain("needsMigrationRecoveryKey &&");
    expect(source).not.toContain("通过密码库设置或恢复流程重新设置恢复密钥");
  });

  test("English blockers distinguish the vault recovery key from Qiniu credentials", () => {
    useLocaleStore.getState().setLocale("en");
    expect(profileSaveBlockers(saveInput())[1]).toContain(
      "Yuncang vault recovery key",
    );
    expect(profileSaveBlockers(saveInput())[1]).toContain(
      "not the Qiniu SecretKey",
    );
  });
});
