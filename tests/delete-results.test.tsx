import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeleteFailureDetails } from "../src/mainview/components/objects/DeleteResultNotice";
import {
  deleteFailureDetails,
  summarizeDeleteResults,
} from "../src/mainview/components/objects/delete-results";
import { useLocaleStore } from "../src/mainview/stores/useLocaleStore";

afterEach(() => useLocaleStore.setState({ locale: "zh-CN" }));

describe("per-object deletion reports", () => {
  test("confirmed successes stay separate from failed object keys", () => {
    const summary = summarizeDeleteResults(["ok", "denied"], {
      results: [
        { key: "ok", success: true },
        { key: "denied", success: false, error: "Permission denied" },
      ],
    });
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toEqual([
      { key: "denied", success: false, error: "Permission denied" },
    ]);
  });

  test("all-failed reports are not successful HTTP completions", () => {
    const summary = summarizeDeleteResults(["a", "b"], {
      results: [
        { key: "a", success: false, error: "Denied" },
        { key: "b", success: false },
      ],
    });
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toHaveLength(2);
    expect(summary.failed[1].error).toContain("删除失败");
  });

  test("empty or missing replies fail every requested object closed", () => {
    for (const report of [undefined, null, {}, { results: [] }]) {
      const summary = summarizeDeleteResults(["a", "b"], report);
      expect(summary.succeeded).toBe(0);
      expect(summary.failed.map((result) => result.key)).toEqual(["a", "b"]);
    }
  });

  test("missing item is failure while another explicitly confirmed item remains success", () => {
    const summary = summarizeDeleteResults(["a", "b"], {
      results: [{ key: "a", success: true }],
    });
    expect(summary.succeeded).toBe(1);
    expect(summary.failed[0].key).toBe("b");
    expect(summary.failed[0].error).toContain("未确认");
  });

  test("duplicates, foreign keys and malformed item values cannot grant success", () => {
    for (const results of [
      [
        { key: "a", success: true },
        { key: "a", success: true },
      ],
      [{ key: "foreign", success: true }],
      [{ key: "a", success: "true" }],
      [{ key: "a", success: true, error: "actually failed" }],
      [null],
    ]) {
      const summary = summarizeDeleteResults(["a", "b"], { results });
      expect(summary.succeeded).toBe(0);
      expect(summary.failed).toHaveLength(2);
    }
  });

  test("repeated requested keys are counted once", () => {
    const summary = summarizeDeleteResults(["a", "a"], {
      results: [{ key: "a", success: true }],
    });
    expect(summary.succeeded).toBe(1);
    expect(summary.results).toHaveLength(1);
    expect(summary.failed).toEqual([]);
  });

  test("signed URLs and raw credential-looking service diagnostics are hidden", () => {
    for (const error of [
      "GET https://private.example/key?token=sensitive-token",
      "Authorization: AWS sensitive-token",
      "AccessKeyId=sensitive-token",
      "SessionToken=sensitive-token",
      "X-Amz-Credential=sensitive-token",
      "secret_access_key=sensitive-token",
      "access key id sensitive-token",
    ]) {
      const summary = summarizeDeleteResults(["a"], {
        results: [{ key: "a", success: false, error }],
      });
      expect(summary.failed[0].error).not.toContain("sensitive-token");
      expect(summary.failed[0].error).toContain("隐藏");
    }
  });

  test("long service diagnostics and absent error strings use bounded safe messages", () => {
    const summary = summarizeDeleteResults(["a", "b"], {
      results: [
        { key: "a", success: false, error: "x".repeat(513) },
        { key: "b", success: false, error: { request: "not printable" } },
      ],
    });
    expect(summary.failed[0].error?.length).toBeLessThan(512);
    expect(summary.failed[1].error).not.toContain("not printable");
  });

  test("details copy escapes newline keys and retains exact Unicode names", () => {
    const summary = summarizeDeleteResults(["目录/+%?#\nfile.txt"], {
      results: [
        { key: "目录/+%?#\nfile.txt", success: false, error: "Denied" },
      ],
    });
    const text = deleteFailureDetails("test-bucket", summary.failed);
    expect(text).toContain('"目录/+%?#\\nfile.txt": Denied');
    expect(text.split("\n")).toHaveLength(2);
  });

  test("failure list renders every object, allows selection and escapes markup", () => {
    const summary = summarizeDeleteResults(["<script>bad</script>", "two"], {
      results: [
        { key: "<script>bad</script>", success: false, error: "Denied" },
        { key: "two", success: false, error: "Unavailable" },
      ],
    });
    const html = renderToStaticMarkup(
      <DeleteFailureDetails bucket="bucket-a" summary={summary} />,
    );
    expect(html).toContain("bucket-a");
    expect(html).toContain("删除失败明细");
    expect(html).toContain("select-text");
    expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("two");
    expect(html).toContain("Unavailable");
  });

  test("English fallback and accessibility labels are translated", () => {
    useLocaleStore.setState({ locale: "en" });
    const summary = summarizeDeleteResults(["object"], { results: [] });
    expect(summary.failed[0].error).toContain("did not confirm");
    const html = renderToStaticMarkup(
      <DeleteFailureDetails bucket="bucket-a" summary={summary} />,
    );
    expect(html).toContain("Original bucket");
    expect(html).toContain("Deletion failure details");
    expect(html).toContain("does not retry automatically");
  });

  test("native adapter reasons switch language without rewriting unknown provider text", () => {
    const report = {
      results: [
        {
          key: "a",
          success: false,
          error:
            "访问被拒绝，请检查对象删除权限 / Access denied; check object-delete permission",
        },
      ],
    };
    expect(summarizeDeleteResults(["a"], report).failed[0].error).toBe(
      "访问被拒绝，请检查对象删除权限",
    );
    useLocaleStore.setState({ locale: "en" });
    expect(summarizeDeleteResults(["a"], report).failed[0].error).toBe(
      "Access denied; check object-delete permission",
    );
    expect(
      summarizeDeleteResults(["a"], {
        results: [
          { key: "a", success: false, error: "Provider text / literal path" },
        ],
      }).failed[0].error,
    ).toBe("Provider text / literal path");
  });
});
