import * as github from "@actions/github";
import type {
  IssuesEvent,
  IssuesAssignedEvent,
  IssueCommentEvent,
  PullRequestEvent,
  PullRequestReviewEvent,
  PullRequestReviewCommentEvent,
  WorkflowRunEvent,
} from "@octokit/webhooks-types";
export type ModeName = "tag" | "agent";
const DEFAULT_MODE: ModeName = "tag";
const VALID_MODES: readonly ModeName[] = ["tag", "agent"] as const;
function isValidMode(value: string): value is ModeName {
  return (VALID_MODES as readonly string[]).includes(value);
}

type CommonInputs = {
  mode: ModeName;
  triggerPhrase: string;
  assigneeTrigger: string;
  labelTrigger: string;
  allowedTools: string[];
  disallowedTools: string[];
  customInstructions: string;
  directPrompt: string;
  overridePrompt: string;
  prompt?: string;
  baseBranch?: string;
  branchPrefix: string;
  branchNameTemplate?: string;
  useStickyComment: boolean;
  additionalPermissions: Map<string, string>;
  useCommitSigning: boolean;
  sshSigningKey?: string;
  allowedNonWriteUsers?: string;
  allowedBots?: string;
  botId?: string;
  botName?: string;
  includeFixLinks?: boolean;
  includeCommentsByActor?: string;
  excludeCommentsByActor?: string;
};

type BaseContext = {
  runId: string;
  eventAction?: string;
  repository: {
    owner: string;
    repo: string;
    full_name: string;
    default_branch?: string;
  };
  actor: string;
  inputs: CommonInputs;
};

export type ParsedGitHubContext = BaseContext & {
  eventName: string;
  payload:
    | IssuesEvent
    | IssueCommentEvent
    | PullRequestEvent
    | PullRequestReviewEvent
    | PullRequestReviewCommentEvent;
  entityNumber: number;
  isPR: boolean;
};

const AUTOMATION_EVENT_NAMES = [
  "workflow_run",
  "workflow_dispatch",
  "schedule",
] as const;

type AutomationEventName = (typeof AUTOMATION_EVENT_NAMES)[number];

export type AutomationContext = BaseContext & {
  eventName: AutomationEventName;
  payload: WorkflowRunEvent | Record<string, any>;
};

export type GitHubContext = ParsedGitHubContext | AutomationContext;

export function parseGitHubContext(): GitHubContext {
  const context = github.context;

  const modeInput = process.env.MODE ?? DEFAULT_MODE;
  if (!isValidMode(modeInput)) {
    throw new Error(`Invalid mode: ${modeInput}.`);
  }

  const commonFields: BaseContext = {
    runId: process.env.GITHUB_RUN_NUMBER!,
    eventAction: context.payload.action,
    repository: {
      owner: context.repo.owner,
      repo: context.repo.repo,
      full_name: `${context.repo.owner}/${context.repo.repo}`,
      default_branch: context.payload.repository?.default_branch,
    },
    actor: context.actor,
    inputs: {
      mode: modeInput as ModeName,
      triggerPhrase: process.env.TRIGGER_PHRASE ?? "@claude",
      assigneeTrigger: process.env.ASSIGNEE_TRIGGER ?? "",
      labelTrigger: process.env.LABEL_TRIGGER ?? "",
      allowedTools: parseMultilineInput(process.env.ALLOWED_TOOLS ?? ""),
      disallowedTools: parseMultilineInput(process.env.DISALLOWED_TOOLS ?? ""),
      customInstructions: process.env.CUSTOM_INSTRUCTIONS ?? "",
      directPrompt: process.env.DIRECT_PROMPT ?? "",
      overridePrompt: process.env.OVERRIDE_PROMPT ?? "",
      baseBranch: process.env.BASE_BRANCH,
      branchPrefix: process.env.BRANCH_PREFIX ?? "claude/",
      branchNameTemplate: process.env.BRANCH_NAME_TEMPLATE,
      useStickyComment: process.env.USE_STICKY_COMMENT === "true",
      additionalPermissions: parseAdditionalPermissions(
        process.env.ADDITIONAL_PERMISSIONS ?? "",
      ),
      useCommitSigning: process.env.USE_COMMIT_SIGNING === "true",
      sshSigningKey: process.env.SSH_SIGNING_KEY ?? "",
      prompt: process.env.PROMPT ?? "",
      allowedNonWriteUsers: process.env.ALLOWED_NON_WRITE_USERS ?? "",
      allowedBots: process.env.ALLOWED_BOTS ?? "",
      botId: process.env.BOT_ID ?? "",
      botName: process.env.BOT_NAME ?? "",
      includeFixLinks: process.env.INCLUDE_FIX_LINKS !== "false",
      includeCommentsByActor: process.env.INCLUDE_COMMENTS_BY_ACTOR ?? "",
      excludeCommentsByActor: process.env.EXCLUDE_COMMENTS_BY_ACTOR ?? "",
    },
  };

  switch (context.eventName) {
    case "issues": {
      return {
        ...commonFields,
        eventName: context.eventName,
        payload: context.payload as IssuesEvent,
        entityNumber: (context.payload as IssuesEvent).issue.number,
        isPR: false,
      };
    }
    case "issue_comment": {
      return {
        ...commonFields,
        eventName: context.eventName,
        payload: context.payload as IssueCommentEvent,
        entityNumber: (context.payload as IssueCommentEvent).issue.number,
        isPR: Boolean(
          (context.payload as IssueCommentEvent).issue.pull_request,
        ),
      };
    }
    case "pull_request": {
      return {
        ...commonFields,
        eventName: context.eventName,
        payload: context.payload as PullRequestEvent,
        entityNumber: (context.payload as PullRequestEvent).pull_request.number,
        isPR: true,
      };
    }
    case "pull_request_review": {
      return {
        ...commonFields,
        eventName: context.eventName,
        payload: context.payload as PullRequestReviewEvent,
        entityNumber: (context.payload as PullRequestReviewEvent).pull_request
          .number,
        isPR: true,
      };
    }
    case "pull_request_review_comment": {
      return {
        ...commonFields,
        eventName: context.eventName,
        payload: context.payload as PullRequestReviewCommentEvent,
        entityNumber: (context.payload as PullRequestReviewCommentEvent)
          .pull_request.number,
        isPR: true,
      };
    }
    case "workflow_run": {
      return {
        ...commonFields,
        eventName: "workflow_run" as const,
        payload: context.payload as unknown as WorkflowRunEvent,
      };
    }
    case "workflow_dispatch": {
      return {
        ...commonFields,
        eventName: "workflow_dispatch" as const,
        payload: context.payload as Record<string, any>,
      };
    }
    case "schedule": {
      return {
        ...commonFields,
        eventName: "schedule" as const,
        payload: context.payload as Record<string, any>,
      };
    }
    default:
      throw new Error(`Unsupported event type: ${context.eventName}`);
  }
}

export function parseMultilineInput(s: string): string[] {
  return s
    .split(/,|[\n\r]+/)
    .map((tool) => tool.replace(/#.+$/, ""))
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
}

export function parseAdditionalPermissions(s: string): Map<string, string> {
  const permissions = new Map<string, string>();
  if (!s || !s.trim()) {
    return permissions;
  }

  const lines = s.trim().split("\n");
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine) {
      const [key, value] = trimmedLine.split(":").map((part) => part.trim());
      if (key && value) {
        permissions.set(key, value);
      }
    }
  }
  return permissions;
}

export function isEntityContext(
  context: GitHubContext,
): context is ParsedGitHubContext {
  return "entityNumber" in context && "isPR" in context;
}

export function isAutomationEvent(
  context: GitHubContext,
): context is AutomationContext {
  return AUTOMATION_EVENT_NAMES.includes(
    context.eventName as AutomationEventName,
  );
}

export function isIssuesEvent(
  context: GitHubContext,
): context is ParsedGitHubContext & { payload: IssuesEvent } {
  return context.eventName === "issues";
}

export function isIssueCommentEvent(
  context: GitHubContext,
): context is ParsedGitHubContext & { payload: IssueCommentEvent } {
  return context.eventName === "issue_comment";
}

export function isPullRequestEvent(
  context: GitHubContext,
): context is ParsedGitHubContext & { payload: PullRequestEvent } {
  return context.eventName === "pull_request";
}

export function isPullRequestReviewEvent(
  context: GitHubContext,
): context is ParsedGitHubContext & { payload: PullRequestReviewEvent } {
  return context.eventName === "pull_request_review";
}

export function isPullRequestReviewCommentEvent(
  context: GitHubContext,
): context is ParsedGitHubContext & { payload: PullRequestReviewCommentEvent } {
  return context.eventName === "pull_request_review_comment";
}

export function isIssuesAssignedEvent(
  context: GitHubContext,
): context is ParsedGitHubContext & { payload: IssuesAssignedEvent } {
  return isIssuesEvent(context) && context.eventAction === "assigned";
}
