import { describe, expect, test } from "bun:test";

import { detectHost, hostFromRemoteUrl } from "./index";

describe("hostFromRemoteUrl (Story 4.4 AC2 — map remote → host CLI)", () => {
  test("gitlab.com → glab (ssh + https)", () => {
    expect(hostFromRemoteUrl("git@gitlab.com:pedro/repo.git")).toBe("glab");
    expect(hostFromRemoteUrl("https://gitlab.com/pedro/repo.git")).toBe("glab");
  });

  test("github.com → gh (ssh + https)", () => {
    expect(hostFromRemoteUrl("git@github.com:pedro/repo.git")).toBe("gh");
    expect(hostFromRemoteUrl("https://github.com/pedro/repo")).toBe("gh");
  });

  test("self-hosted gitlab/github subdomains still map by host segment", () => {
    expect(hostFromRemoteUrl("git@gitlab.example.com:team/repo.git")).toBe("glab");
    expect(hostFromRemoteUrl("https://github.enterprise.io/team/repo.git")).toBe("gh");
  });

  test("https with embedded credentials still resolves the host", () => {
    expect(hostFromRemoteUrl("https://user:tok@gitlab.com/pedro/repo.git")).toBe("glab");
  });

  test("unknown forge or empty → null (no guess)", () => {
    expect(hostFromRemoteUrl("git@bitbucket.org:pedro/repo.git")).toBeNull();
    expect(hostFromRemoteUrl("")).toBeNull();
    expect(hostFromRemoteUrl("   ")).toBeNull();
    expect(hostFromRemoteUrl("not a url")).toBeNull();
  });
});

describe("detectHost (AC2 — auto-detect, override wins, non-fatal fallback)", () => {
  test("auto-detects from the injected remote URL", () => {
    expect(detectHost({ remoteUrl: "https://gitlab.com/p/r.git" })).toBe("glab");
    expect(detectHost({ remoteUrl: "git@github.com:p/r.git" })).toBe("gh");
  });

  test("an explicit override beats detection (even a contradictory remote)", () => {
    expect(detectHost({ override: "gh", remoteUrl: "https://gitlab.com/p/r.git" })).toBe("gh");
    expect(detectHost({ override: "glab", remoteUrl: "git@github.com:p/r.git" })).toBe("glab");
  });

  test("no remote (null) and unrecognized host → null, never a crash", () => {
    expect(detectHost({ remoteUrl: null })).toBeNull();
    expect(detectHost({ remoteUrl: "git@bitbucket.org:p/r.git" })).toBeNull();
  });
});
