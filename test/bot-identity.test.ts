import { describe, it, expect } from "bun:test";
import { getBotUserFromInputs } from "../src/github/operations/git-config";
import { createMockContext } from "./mockContext";

describe("getBotUserFromInputs", () => {
  it("returns null when neither bot_id nor bot_name is set", () => {
    const context = createMockContext();
    expect(getBotUserFromInputs(context)).toBeNull();
  });

  it("returns null when only bot_name is set", () => {
    const context = createMockContext({
      inputs: {
        ...createMockContext().inputs,
        botName: "claude[bot]",
      },
    });
    expect(getBotUserFromInputs(context)).toBeNull();
  });

  it("returns null when only bot_id is set", () => {
    const context = createMockContext({
      inputs: {
        ...createMockContext().inputs,
        botId: "41898282",
      },
    });
    expect(getBotUserFromInputs(context)).toBeNull();
  });

  it("returns {login, id} when both inputs are set", () => {
    const context = createMockContext({
      inputs: {
        ...createMockContext().inputs,
        botId: "41898282",
        botName: "claude[bot]",
      },
    });
    expect(getBotUserFromInputs(context)).toEqual({
      login: "claude[bot]",
      id: 41898282,
    });
  });

  it("returns null when bot_id isn't a valid integer", () => {
    const context = createMockContext({
      inputs: {
        ...createMockContext().inputs,
        botId: "not-a-number",
        botName: "claude[bot]",
      },
    });
    expect(getBotUserFromInputs(context)).toBeNull();
  });

  it("returns null when bot_id is zero or negative", () => {
    const zero = createMockContext({
      inputs: {
        ...createMockContext().inputs,
        botId: "0",
        botName: "claude[bot]",
      },
    });
    expect(getBotUserFromInputs(zero)).toBeNull();

    const neg = createMockContext({
      inputs: {
        ...createMockContext().inputs,
        botId: "-5",
        botName: "claude[bot]",
      },
    });
    expect(getBotUserFromInputs(neg)).toBeNull();
  });

  it("trims whitespace around inputs", () => {
    const context = createMockContext({
      inputs: {
        ...createMockContext().inputs,
        botId: "  42  ",
        botName: "  gitea-bot  ",
      },
    });
    expect(getBotUserFromInputs(context)).toEqual({
      login: "gitea-bot",
      id: 42,
    });
  });

  it("treats empty strings as unset (matches action.yml default)", () => {
    const context = createMockContext({
      inputs: {
        ...createMockContext().inputs,
        botId: "",
        botName: "",
      },
    });
    expect(getBotUserFromInputs(context)).toBeNull();
  });
});
