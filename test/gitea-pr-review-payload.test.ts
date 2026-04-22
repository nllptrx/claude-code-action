import { describe, it, expect } from "bun:test";
import {
  buildPrReviewPayload,
  createPrReviewInputSchema,
} from "../src/mcp/gitea-pr-review-payload";

describe("createPrReviewInputSchema", () => {
  it("accepts event: COMMENT", () => {
    expect(
      createPrReviewInputSchema.safeParse({
        owner: "alice",
        repo: "r",
        index: 1,
        event: "COMMENT",
      }).success,
    ).toBe(true);
  });

  it("accepts event: REQUEST_CHANGES", () => {
    expect(
      createPrReviewInputSchema.safeParse({
        owner: "alice",
        repo: "r",
        index: 1,
        event: "REQUEST_CHANGES",
      }).success,
    ).toBe(true);
  });

  it("REJECTS event: APPROVED (intentional guardrail)", () => {
    const result = createPrReviewInputSchema.safeParse({
      owner: "alice",
      repo: "r",
      index: 1,
      event: "APPROVED",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive PR index", () => {
    expect(
      createPrReviewInputSchema.safeParse({
        owner: "alice",
        repo: "r",
        index: 0,
        event: "COMMENT",
      }).success,
    ).toBe(false);

    expect(
      createPrReviewInputSchema.safeParse({
        owner: "alice",
        repo: "r",
        index: -3,
        event: "COMMENT",
      }).success,
    ).toBe(false);
  });

  it("accepts inline comments with new_position (RIGHT side)", () => {
    const r = createPrReviewInputSchema.safeParse({
      owner: "alice",
      repo: "r",
      index: 1,
      event: "COMMENT",
      comments: [{ body: "nit", path: "src/a.ts", new_position: 42 }],
    });
    expect(r.success).toBe(true);
  });

  it("accepts inline comments with old_position (LEFT side)", () => {
    const r = createPrReviewInputSchema.safeParse({
      owner: "alice",
      repo: "r",
      index: 1,
      event: "COMMENT",
      comments: [
        { body: "was this intentional?", path: "src/a.ts", old_position: 12 },
      ],
    });
    expect(r.success).toBe(true);
  });
});

describe("buildPrReviewPayload", () => {
  it("bare COMMENT produces only { event }", () => {
    expect(buildPrReviewPayload({ event: "COMMENT" })).toEqual({
      event: "COMMENT",
    });
  });

  it("REQUEST_CHANGES with a body preserves both", () => {
    const p = buildPrReviewPayload({
      event: "REQUEST_CHANGES",
      body: "Please fix the N+1 in UserRepo",
    });
    expect(p).toEqual({
      event: "REQUEST_CHANGES",
      body: "Please fix the N+1 in UserRepo",
    });
  });

  it("passes commit_id through unchanged", () => {
    const p = buildPrReviewPayload({
      event: "COMMENT",
      commit_id: "abc123",
    });
    expect(p.commit_id).toBe("abc123");
  });

  it("includes comments[] only when non-empty", () => {
    const empty = buildPrReviewPayload({ event: "COMMENT", comments: [] });
    expect("comments" in empty).toBe(false);

    const withOne = buildPrReviewPayload({
      event: "COMMENT",
      comments: [{ body: "x", path: "f", new_position: 1 }],
    });
    expect(Array.isArray(withOne.comments)).toBe(true);
  });

  it("emits new_position or old_position only when provided", () => {
    const p = buildPrReviewPayload({
      event: "COMMENT",
      comments: [
        { body: "right-side", path: "a", new_position: 10 },
        { body: "left-side", path: "a", old_position: 5 },
        { body: "bare", path: "b" },
      ],
    });
    const cs = p.comments as Array<Record<string, unknown>>;
    expect("new_position" in cs[0]!).toBe(true);
    expect("old_position" in cs[0]!).toBe(false);
    expect("new_position" in cs[1]!).toBe(false);
    expect("old_position" in cs[1]!).toBe(true);
    expect("new_position" in cs[2]!).toBe(false);
    expect("old_position" in cs[2]!).toBe(false);
  });

  it("sanitizes the review body", () => {
    // sanitizeContent strips control chars; feed a null byte and verify it's gone.
    const p = buildPrReviewPayload({
      event: "COMMENT",
      body: "clean\x00dirty",
    });
    expect(p.body).not.toContain("\x00");
  });

  it("sanitizes each inline comment body independently", () => {
    const p = buildPrReviewPayload({
      event: "COMMENT",
      comments: [
        { body: "hello\x00world", path: "a.ts", new_position: 1 },
        { body: "normal", path: "b.ts", new_position: 2 },
      ],
    });
    const cs = p.comments as Array<Record<string, unknown>>;
    expect(cs[0]!.body).not.toContain("\x00");
    expect(cs[1]!.body).toBe("normal");
  });

  it("omits optional review-level fields when not provided", () => {
    const p = buildPrReviewPayload({ event: "COMMENT" });
    expect("body" in p).toBe(false);
    expect("commit_id" in p).toBe(false);
    expect("comments" in p).toBe(false);
  });
});
