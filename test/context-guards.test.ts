import { describe, it, expect } from "bun:test";
import {
  isEntityContext,
  isAutomationEvent,
  type ParsedGitHubContext,
  type AutomationContext,
  type GitHubContext,
} from "../src/github/context";
import { createMockContext } from "./mockContext";

const automationBase = {
  runId: "run-1",
  eventAction: undefined,
  repository: {
    owner: "test-owner",
    repo: "test-repo",
    full_name: "test-owner/test-repo",
  },
  actor: "test-actor",
  inputs: createMockContext().inputs,
};

describe("GitHubContext discriminated union guards", () => {
  describe("isEntityContext", () => {
    it("returns true for ParsedGitHubContext (issues event)", () => {
      const context: ParsedGitHubContext = createMockContext({
        eventName: "issues",
        entityNumber: 42,
        isPR: false,
      });
      expect(isEntityContext(context)).toBe(true);
    });

    it("returns true for ParsedGitHubContext (pull_request event)", () => {
      const context: ParsedGitHubContext = createMockContext({
        eventName: "pull_request",
        entityNumber: 7,
        isPR: true,
      });
      expect(isEntityContext(context)).toBe(true);
    });

    it("returns false for AutomationContext", () => {
      const context: AutomationContext = {
        ...automationBase,
        eventName: "workflow_dispatch",
        payload: { inputs: { foo: "bar" } },
      };
      expect(isEntityContext(context)).toBe(false);
    });

    it("narrows the type so entityNumber/isPR are accessible", () => {
      const context: GitHubContext = createMockContext({
        eventName: "pull_request_review",
        entityNumber: 321,
        isPR: true,
      });
      if (isEntityContext(context)) {
        expect(typeof context.entityNumber).toBe("number");
        expect(typeof context.isPR).toBe("boolean");
      } else {
        throw new Error("expected entity context");
      }
    });
  });

  describe("isAutomationEvent", () => {
    it.each(["workflow_run", "workflow_dispatch", "schedule"])(
      "returns true for %s",
      (eventName) => {
        const context: AutomationContext = {
          ...automationBase,
          eventName: eventName as AutomationContext["eventName"],
          payload: {} as AutomationContext["payload"],
        };
        expect(isAutomationEvent(context)).toBe(true);
      },
    );

    it("returns false for entity events (issues)", () => {
      const context = createMockContext({ eventName: "issues" });
      expect(isAutomationEvent(context)).toBe(false);
    });

    it("returns false for entity events (pull_request)", () => {
      const context = createMockContext({ eventName: "pull_request" });
      expect(isAutomationEvent(context)).toBe(false);
    });

    it("returns false for issue_comment", () => {
      const context = createMockContext({ eventName: "issue_comment" });
      expect(isAutomationEvent(context)).toBe(false);
    });
  });

  describe("union discriminator is mutually exclusive", () => {
    it("entity contexts are never automation events", () => {
      const entityEvents = [
        "issues",
        "issue_comment",
        "pull_request",
        "pull_request_review",
        "pull_request_review_comment",
      ];
      for (const eventName of entityEvents) {
        const context = createMockContext({ eventName });
        expect(isEntityContext(context)).toBe(true);
        expect(isAutomationEvent(context)).toBe(false);
      }
    });

    it("automation contexts are never entity contexts", () => {
      const automationEvents: AutomationContext["eventName"][] = [
        "workflow_run",
        "workflow_dispatch",
        "schedule",
      ];
      for (const eventName of automationEvents) {
        const context: AutomationContext = {
          ...automationBase,
          eventName,
          payload: {} as AutomationContext["payload"],
        };
        expect(isAutomationEvent(context)).toBe(true);
        expect(isEntityContext(context)).toBe(false);
      }
    });
  });
});
