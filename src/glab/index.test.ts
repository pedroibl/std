import { describe, expect, test } from "bun:test";

import { currentBranch, parseApiOutput, parseRemoteUrl, resolveRepo, run } from "./index";

describe("parseApiOutput (Story 3.1 — fail-soft, never throws)", () => {
  test("parses valid JSON into T", () => {
    expect(parseApiOutput<{ iid: number }>('{"iid":7}')).toEqual({ iid: 7 });
  });

  test("empty / whitespace body → null", () => {
    expect(parseApiOutput("")).toBeNull();
    expect(parseApiOutput("   \n")).toBeNull();
  });

  test("non-JSON body → null (no throw)", () => {
    expect(parseApiOutput("not json {")).toBeNull();
  });
});

describe("currentBranch (Story 3.2)", () => {
  test("returns a string (the branch, or '' when unresolved)", () => {
    expect(typeof currentBranch()).toBe("string");
  });
});

describe("run dispatch map (Story 3.3)", () => {
  test("unknown command → exit code 2", () => {
    expect(run(["__no_such_command__"], { repo: "acme/widgets" })).toBe(2);
  });

  test("empty argv → exit code 2", () => {
    expect(run([], { repo: "acme/widgets" })).toBe(2);
  });

  test("a known command dispatches to a handler returning a numeric code", () => {
    // `glab` failing (unauth/missing) degrades to null inside the handler — still a number.
    expect(typeof run(["pipeline"], { repo: "acme/widgets" })).toBe("number");
  });
});

describe("parseRemoteUrl + resolveRepo (Story 3.4 — git-remote-first, no baked default)", () => {
  test("SSH remote → owner/repo", () => {
    expect(parseRemoteUrl("git@gitlab.com:acme/widgets.git")).toBe("acme/widgets");
  });

  test("HTTPS remote → owner/repo, trailing .git stripped, host-agnostic (incl. self-hosted)", () => {
    expect(parseRemoteUrl("https://gitlab.com/acme/widgets.git")).toBe("acme/widgets");
    expect(parseRemoteUrl("https://gitlab.example.com/acme/widgets")).toBe("acme/widgets");
  });

  test("nested groups are preserved", () => {
    expect(parseRemoteUrl("https://gitlab.com/group/sub/proj.git")).toBe("group/sub/proj");
  });

  test("non-repo shapes → null", () => {
    expect(parseRemoteUrl("")).toBeNull();
    expect(parseRemoteUrl("not-a-url")).toBeNull();
    expect(parseRemoteUrl("git@host:noslash")).toBeNull();
  });

  test("explicit repo wins over the git remote (no git call needed)", () => {
    expect(resolveRepo({ repo: "owner/repo" })).toBe("owner/repo");
  });

  test("with no explicit repo, resolution is a string or null (git-remote-first)", () => {
    const r = resolveRepo({});
    expect(r === null || typeof r === "string").toBe(true);
  });
});
