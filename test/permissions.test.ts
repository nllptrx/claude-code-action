import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import * as core from "@actions/core";
import { checkWritePermissions } from "../src/github/validation/permissions";
import type { ParsedGitHubContext } from "../src/github/context";

const baseContext: ParsedGitHubContext = {
  runId: "123",
  eventName: "issue_comment",
  eventAction: "created",
  repository: {
    owner: "owner",
    repo: "repo",
    full_name: "owner/repo",
  },
  actor: "tester",
  payload: {
    action: "created",
    issue: { number: 1, body: "", title: "", user: { login: "owner" } },
    comment: { id: 1, body: "@claude ping", user: { login: "tester" } },
  } as any,
  entityNumber: 1,
  isPR: false,
  inputs: {
    mode: "tag",
    triggerPhrase: "@claude",
    assigneeTrigger: "",
    labelTrigger: "",
    allowedTools: [],
    disallowedTools: [],
    customInstructions: "",
    directPrompt: "",
    overridePrompt: "",
    branchPrefix: "claude/",
    useStickyComment: false,
    additionalPermissions: new Map(),
    useCommitSigning: false,
  },
};

describe("checkWritePermissions", () => {
  let infoSpy: any;

  beforeEach(() => {
    infoSpy = spyOn(core, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  test("returns true when token has push permission", async () => {
    const mockApi = {
      getRepo: async () => ({
        data: { permissions: { admin: false, push: true, pull: true } },
      }),
    } as any;

    const result = await checkWritePermissions(mockApi, baseContext);
    expect(result).toBe(true);
  });

  test("returns true when token has admin permission", async () => {
    const mockApi = {
      getRepo: async () => ({
        data: { permissions: { admin: true, push: false, pull: true } },
      }),
    } as any;

    const result = await checkWritePermissions(mockApi, baseContext);
    expect(result).toBe(true);
  });

  test("returns false when token lacks write access", async () => {
    const warnSpy = spyOn(core, "warning").mockImplementation(() => {});
    const mockApi = {
      getRepo: async () => ({
        data: { permissions: { admin: false, push: false, pull: true } },
      }),
    } as any;

    const result = await checkWritePermissions(mockApi, baseContext);
    expect(result).toBe(false);
    warnSpy.mockRestore();
  });

  test("returns true when permissions field is missing (Gitea workflow token)", async () => {
    const mockApi = {
      getRepo: async () => ({ data: { full_name: "owner/repo" } }),
    } as any;

    const result = await checkWritePermissions(mockApi, baseContext);
    expect(result).toBe(true);
  });

  test("throws when API call fails", async () => {
    const errorSpy = spyOn(core, "error").mockImplementation(() => {});
    const mockApi = {
      getRepo: async () => {
        throw new Error("connection refused");
      },
    } as any;

    expect(checkWritePermissions(mockApi, baseContext)).rejects.toThrow(
      "Failed to check permissions for tester",
    );
    errorSpy.mockRestore();
  });

  describe("collaborator permission endpoint", () => {
    test("returns true when collaborator permission is 'write'", async () => {
      const mockApi = {
        getCollaboratorPermission: async () => ({
          data: { permission: "write" },
        }),
      } as any;
      const result = await checkWritePermissions(mockApi, baseContext);
      expect(result).toBe(true);
    });

    test("returns true when collaborator permission is 'admin'", async () => {
      const mockApi = {
        getCollaboratorPermission: async () => ({
          data: { permission: "admin" },
        }),
      } as any;
      const result = await checkWritePermissions(mockApi, baseContext);
      expect(result).toBe(true);
    });

    test("returns false when collaborator permission is 'read'", async () => {
      const warnSpy = spyOn(core, "warning").mockImplementation(() => {});
      const mockApi = {
        getCollaboratorPermission: async () => ({
          data: { permission: "read" },
        }),
      } as any;
      const result = await checkWritePermissions(mockApi, baseContext);
      expect(result).toBe(false);
      warnSpy.mockRestore();
    });

    test("falls back to getRepo when collaborator endpoint throws", async () => {
      const mockApi = {
        getCollaboratorPermission: async () => {
          throw new Error("404 Not Found");
        },
        getRepo: async () => ({
          data: { permissions: { admin: false, push: true, pull: true } },
        }),
      } as any;
      const result = await checkWritePermissions(mockApi, baseContext);
      expect(result).toBe(true);
    });
  });

  describe("allowed_non_write_users bypass", () => {
    const warnSpy = () => spyOn(core, "warning").mockImplementation(() => {});

    test("bypasses permission check when actor is in allowlist and gitea_token provided", async () => {
      const spy = warnSpy();
      const mockApi = {
        getCollaboratorPermission: async () => ({
          data: { permission: "read" },
        }),
      } as any;
      const result = await checkWritePermissions(
        mockApi,
        baseContext,
        "alice, tester, bob",
        true,
      );
      expect(result).toBe(true);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    test("bypasses for any actor when allowlist is '*' and gitea_token provided", async () => {
      const spy = warnSpy();
      const mockApi = {
        getCollaboratorPermission: async () => ({
          data: { permission: "read" },
        }),
      } as any;
      const result = await checkWritePermissions(
        mockApi,
        baseContext,
        "*",
        true,
      );
      expect(result).toBe(true);
      spy.mockRestore();
    });

    test("does NOT bypass when giteaTokenProvided is false (even if actor is in list)", async () => {
      const spy = spyOn(core, "warning").mockImplementation(() => {});
      const mockApi = {
        getCollaboratorPermission: async () => ({
          data: { permission: "read" },
        }),
      } as any;
      const result = await checkWritePermissions(
        mockApi,
        baseContext,
        "tester",
        false,
      );
      expect(result).toBe(false);
      spy.mockRestore();
    });

    test("does NOT bypass when actor is not in allowlist", async () => {
      const spy = spyOn(core, "warning").mockImplementation(() => {});
      const mockApi = {
        getCollaboratorPermission: async () => ({
          data: { permission: "read" },
        }),
      } as any;
      const result = await checkWritePermissions(
        mockApi,
        baseContext,
        "alice,bob",
        true,
      );
      expect(result).toBe(false);
      spy.mockRestore();
    });
  });

  describe("bot actor suffix", () => {
    test("allows actors ending in [bot] without calling the API", async () => {
      const botContext = { ...baseContext, actor: "renovate[bot]" };
      const mockApi = {
        getCollaboratorPermission: async () => {
          throw new Error("should not be called");
        },
      } as any;
      const result = await checkWritePermissions(mockApi, botContext);
      expect(result).toBe(true);
    });
  });

  describe("repo owner short-circuit", () => {
    test("allows actor when it matches repository.owner without calling the API", async () => {
      // baseContext has actor "tester" and owner "owner"; construct one where
      // actor equals owner to exercise the short-circuit.
      const ownerContext = {
        ...baseContext,
        actor: "owner",
      };
      const mockApi = {
        getCollaboratorPermission: async () => {
          throw new Error("should not be called");
        },
        getRepo: async () => {
          throw new Error("should not be called");
        },
      } as any;
      const result = await checkWritePermissions(mockApi, ownerContext);
      expect(result).toBe(true);
    });
  });
});
