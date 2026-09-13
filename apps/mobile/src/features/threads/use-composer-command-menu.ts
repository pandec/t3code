import type {
  EnvironmentId,
  ProjectId,
  ProviderInteractionMode,
  ServerProvider,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { COMPOSER_CONTEXT_MAX_RECORDS } from "@t3tools/contracts";
import { Alert } from "react-native";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { pullRequestComposerContext } from "../../lib/composerContext";
import { uuidv4 } from "../../lib/uuid";
import {
  getComposerDraftSnapshot,
  readComposerDraftSelection,
  setComposerDraftContext,
} from "../../state/use-composer-drafts";
import { USAGE_LIMITS_COMMAND } from "@t3tools/shared/usageLimits";
import {
  buildThreadTitleComposerText,
  detectComposerTrigger,
  replaceTextRange,
  serializeComposerFileLink,
  type ComposerTrigger,
} from "@t3tools/shared/composerTrigger";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";
import {
  dedupeProviderSkillsByName,
  getProviderSkillsForSlashMenu,
  isProviderSkillUserInvocable,
} from "@t3tools/client-runtime/providerSkills";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { useComposerPathSearch, useComposerPullRequestSearch } from "../../state/queries";
import type { ComposerCommandItem } from "./ComposerCommandPopover";
import { matchesSlashSkillQuery } from "./composerSlashSkillSearch";

// Exported for the fork's test: the owner-key reset must land on the JS string
// end (surrogate pairs count twice), which nothing else pins.
export function composerSelectionAtEnd(draftMessage: string): ComposerEditorSelection {
  return { start: draftMessage.length, end: draftMessage.length };
}

export function buildComposerSlashCommandItems(input: {
  readonly query: string;
  readonly atMessageStart: boolean;
  readonly hasThread: boolean;
  readonly hasCompactableConversation?: boolean;
  /** Whether T3 itself offers /usage-limits for the selected provider. */
  readonly offersUsageLimits?: boolean;
  readonly allowInteractionMode: boolean;
  readonly selectedProviderStatus: Pick<
    ServerProvider,
    "driver" | "slashCommands" | "showInteractionModeToggle"
  > | null;
}): ComposerCommandItem[] {
  const query = input.query.toLowerCase();
  const allowInteractionMode =
    input.allowInteractionMode && input.selectedProviderStatus?.showInteractionModeToggle !== false;
  const builtIn = [
    {
      id: "cmd:model",
      type: "slash-command",
      command: "model",
      label: "/model",
      description: "Switch model",
    },
    {
      id: "cmd:plan",
      type: "slash-command",
      command: "plan",
      label: "/plan",
      description: "Switch to plan mode",
    },
    {
      id: "cmd:default",
      type: "slash-command",
      command: "default",
      label: "/default",
      description: "Switch to default mode",
    },
    ...(input.hasThread
      ? [
          {
            id: "cmd:t3-name",
            type: "slash-command" as const,
            command: "t3-name",
            label: "/t3-name",
            description: "Edit current thread name",
          },
          {
            id: "cmd:t3-rename",
            type: "slash-command" as const,
            command: "t3-rename",
            label: "/t3-rename",
            description: "Set a new thread name",
          },
          {
            id: "cmd:t3-status",
            type: "slash-command" as const,
            command: "t3-status",
            label: "/t3-status",
            description: "Set this thread's status emoji",
          },
        ]
      : []),
  ] satisfies ComposerCommandItem[];
  const items: ComposerCommandItem[] = builtIn.filter(
    (item) =>
      item.command.includes(query) &&
      (item.command === "model" || item.command.startsWith("t3-") || allowInteractionMode),
  );

  // Providers expand commands only at the start of a message. T3 commands
  // change local state and do not have this restriction.
  if (!input.atMessageStart) return items;
  for (const command of input.selectedProviderStatus?.slashCommands ?? []) {
    if (!command.name.toLowerCase().includes(query)) continue;
    if (command.name === "compact" && !input.hasCompactableConversation) continue;
    // T3's own limits command is answered by the thread composer; New Task has
    // nowhere to show it. A provider's same-named command is left alone.
    if (command.name === USAGE_LIMITS_COMMAND.name && input.offersUsageLimits && !input.hasThread) {
      continue;
    }
    if (
      !input.hasThread &&
      input.selectedProviderStatus?.driver === "codex" &&
      command.name === "feedback"
    ) {
      continue;
    }
    items.push({
      id: `pcmd:${command.name}`,
      type: "provider-slash-command",
      command,
      label: `/${command.name}`,
      description: command.description ?? "",
    });
  }
  return items;
}

export function resolveComposerCommandSelection(input: {
  readonly draftMessage: string;
  readonly trigger: Pick<ComposerTrigger, "rangeStart" | "rangeEnd">;
  readonly item: ComposerCommandItem;
  readonly allowInteractionMode: boolean;
  readonly threadTitle?: string | null;
}): {
  readonly text: string;
  readonly cursor: number;
  readonly interactionMode: ProviderInteractionMode | null;
} {
  const { draftMessage, trigger, item } = input;
  if (
    input.allowInteractionMode &&
    item.type === "slash-command" &&
    (item.command === "plan" || item.command === "default")
  ) {
    return {
      ...replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, ""),
      interactionMode: item.command,
    };
  }

  let replacement = "";
  if (item.type === "path") {
    replacement = `${serializeComposerFileLink(item.path)} `;
  } else if (item.type === "skill") {
    replacement = `$${item.skill.name} `;
  } else if (item.type === "slash-command") {
    replacement =
      item.command === "t3-name" || item.command === "t3-rename"
        ? buildThreadTitleComposerText(item.command, input.threadTitle)
        : `/${item.command} `;
  } else if (item.type === "provider-slash-command") {
    replacement = `/${item.command.name} `;
  }
  return {
    ...replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, replacement),
    interactionMode: null,
  };
}

/** Shared autocomplete for thread composers and unsent new-task drafts. */
export function useComposerCommandMenu({
  draftMessage,
  ownerKey,
  environmentId,
  projectCwd,
  pullRequestProjectId = null,
  pullRequestRepository = null,
  selectedProviderStatus,
  providerSkills,
  hasThread,
  threadTitle,
  hasCompactableConversation,
  offersUsageLimits = false,
  enabled = true,
  onChangeDraftMessage,
  onUpdateInteractionMode,
  onUsageLimits,
}: {
  readonly draftMessage: string;
  readonly ownerKey: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly projectCwd: string | null;
  readonly pullRequestProjectId?: ProjectId | null;
  readonly pullRequestRepository?: string | null;
  readonly selectedProviderStatus: ServerProvider | null;
  /**
   * Resolved per-cwd skills (query + status-snapshot fallback), never the raw
   * provider-status list: a thread whose cwd differs from the server's would
   * otherwise see the wrong project's skills.
   */
  readonly providerSkills: ReadonlyArray<ServerProviderSkill>;
  readonly hasThread: boolean;
  /** Current thread title, backing the fork's /t3-name prefill. */
  readonly threadTitle?: string | null;
  readonly hasCompactableConversation: boolean;
  /** Whether T3 itself offers /usage-limits for the selected provider. */
  readonly offersUsageLimits?: boolean;
  readonly enabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onUpdateInteractionMode?: (mode: ProviderInteractionMode) => void;
  /** Picking /usage-limits is the action itself; the draft keeps nothing of it. */
  readonly onUsageLimits?: () => void;
}) {
  const [selection, setSelection] = useState(() => composerSelectionAtEnd(draftMessage));
  const previousOwnerKeyRef = useRef(ownerKey);
  const onSelectionChange = useCallback((nextSelection: ComposerEditorSelection) => {
    setSelection(nextSelection);
  }, []);
  useEffect(() => {
    // An insert (attachment, terminal capture, review comment) rewrites the draft and records
    // the caret that belongs after the new chip. Clamping alone would keep the old offset,
    // which sits before it.
    const inserted = ownerKey ? readComposerDraftSelection(ownerKey, draftMessage) : null;
    if (inserted) {
      setSelection((current) =>
        current.start === inserted.start && current.end === inserted.end ? current : inserted,
      );
      return;
    }
    const end = draftMessage.length;
    setSelection((current) => {
      const start = Math.min(current.start, end);
      const selectionEnd = Math.min(current.end, end);
      if (start === current.start && selectionEnd === current.end) {
        return current;
      }
      return { start, end: selectionEnd };
    });
  }, [draftMessage, ownerKey]);
  useEffect(() => {
    if (previousOwnerKeyRef.current === ownerKey) return;
    previousOwnerKeyRef.current = ownerKey;
    setSelection(composerSelectionAtEnd(draftMessage));
  }, [draftMessage, ownerKey]);

  const trigger = useMemo(() => {
    if (!enabled || selection.start !== selection.end) {
      return null;
    }
    return detectComposerTrigger(draftMessage, selection.end);
  }, [draftMessage, enabled, selection]);
  const pathSearch = useComposerPathSearch({
    environmentId,
    cwd: trigger?.kind === "path" ? projectCwd : null,
    query: trigger?.kind === "path" ? trigger.query : null,
  });
  const pullRequestSearch = useComposerPullRequestSearch({
    environmentId,
    projectId: pullRequestProjectId,
    repository: pullRequestRepository,
    query: trigger?.kind === "pull-request" ? trigger.query : null,
  });

  const items = useMemo<ComposerCommandItem[]>(() => {
    if (!trigger) return [];

    if (trigger.kind === "pull-request") {
      return pullRequestSearch.entries.map((entry) => ({
        id: `pr:${entry.projectId}:${entry.repository}:${entry.number}`,
        type: "pull-request",
        pullRequest: {
          number: entry.number,
          title: entry.title,
          url: entry.url,
          headBranch: entry.headBranch,
          baseBranch: entry.baseBranch,
          state: entry.state,
          isDraft: entry.isDraft,
        },
        label: `#${entry.number}`,
        description: `${entry.isDraft ? "Draft" : entry.state} · ${entry.title}`,
      }));
    }

    if (trigger.kind === "slash-command") {
      const q = trigger.query.toLowerCase();
      const commandItems = buildComposerSlashCommandItems({
        query: q,
        atMessageStart: trigger.rangeStart === 0,
        hasThread,
        hasCompactableConversation,
        offersUsageLimits,
        allowInteractionMode: onUpdateInteractionMode !== undefined,
        selectedProviderStatus,
      });

      const skillItems = getProviderSkillsForSlashMenu(providerSkills, true)
        .filter((skill) => matchesSlashSkillQuery(skill, q))
        .map((skill) => ({
          id: `skill:${skill.name}`,
          type: "skill" as const,
          skill,
          label: `skill:${skill.name}`,
          description: skill.shortDescription ?? skill.description ?? "",
        }));

      return [...commandItems, ...skillItems];
    }

    if (trigger.kind === "skill") {
      const enabledSkills = dedupeProviderSkillsByName(
        providerSkills.filter(isProviderSkillUserInvocable),
      );
      const normalizedQuery = normalizeSearchQuery(trigger.query, {
        trimLeadingPattern: /^\$+/,
      });

      if (!normalizedQuery) {
        return enabledSkills.slice(0, 20).map((skill) => ({
          id: `skill:${skill.name}`,
          type: "skill" as const,
          skill,
          label: skill.displayName ?? skill.name,
          description: skill.shortDescription ?? skill.description ?? "",
        }));
      }

      const ranked: Array<{
        item: (typeof enabledSkills)[number];
        score: number;
        tieBreaker: string;
      }> = [];
      for (const skill of enabledSkills) {
        const displayLabel = (skill.displayName ?? skill.name).toLowerCase();
        const scores = [
          scoreQueryMatch({
            value: skill.name.toLowerCase(),
            query: normalizedQuery,
            exactBase: 0,
            prefixBase: 2,
            boundaryBase: 4,
            includesBase: 6,
            fuzzyBase: 100,
            boundaryMarkers: ["-", "_", "/"],
          }),
          scoreQueryMatch({
            value: displayLabel,
            query: normalizedQuery,
            exactBase: 1,
            prefixBase: 3,
            boundaryBase: 5,
            includesBase: 7,
            fuzzyBase: 110,
          }),
          scoreQueryMatch({
            value: skill.shortDescription?.toLowerCase() ?? "",
            query: normalizedQuery,
            exactBase: 20,
            prefixBase: 22,
            boundaryBase: 24,
            includesBase: 26,
          }),
          scoreQueryMatch({
            value: skill.description?.toLowerCase() ?? "",
            query: normalizedQuery,
            exactBase: 30,
            prefixBase: 32,
            boundaryBase: 34,
            includesBase: 36,
          }),
        ].filter((score): score is number => score !== null);

        if (scores.length > 0) {
          insertRankedSearchResult(
            ranked,
            {
              item: skill,
              score: Math.min(...scores),
              tieBreaker: `${displayLabel}\u0000${skill.name}`,
            },
            20,
          );
        }
      }

      return ranked.map(({ item: skill }) => ({
        id: `skill:${skill.name}`,
        type: "skill" as const,
        skill,
        label: skill.displayName ?? skill.name,
        description: skill.shortDescription ?? skill.description ?? "",
      }));
    }

    if (trigger.kind === "path") {
      return pathSearch.entries.map((entry) => {
        const parts = entry.path.split("/");
        return {
          id: `path:${entry.path}`,
          type: "path" as const,
          path: entry.path,
          kind: entry.kind,
          label: parts[parts.length - 1] ?? entry.path,
          description: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
        };
      });
    }

    return [];
  }, [
    hasThread,
    hasCompactableConversation,
    onUpdateInteractionMode,
    pathSearch.entries,
    providerSkills,
    pullRequestSearch.entries,
    selectedProviderStatus,
    trigger,
    offersUsageLimits,
  ]);

  const onSelect = useCallback(
    (item: ComposerCommandItem) => {
      if (!trigger) return;
      if (item.type === "pull-request") {
        if (
          !ownerKey ||
          trigger.kind !== "pull-request" ||
          !items.some((candidate) => candidate.id === item.id)
        )
          return;
        const record = pullRequestComposerContext(item.pullRequest, uuidv4());
        if (
          (getComposerDraftSnapshot(ownerKey).context?.records.length ?? 0) >=
          COMPOSER_CONTEXT_MAX_RECORDS
        ) {
          Alert.alert(
            "Too many context items",
            "Remove some context from the draft and try again.",
          );
          return;
        }
        const result = replaceTextRange(
          draftMessage,
          trigger.rangeStart,
          trigger.rangeEnd,
          `${formatComposerContextReference(record)} `,
        );
        onChangeDraftMessage(result.text);
        const draft = getComposerDraftSnapshot(ownerKey);
        setComposerDraftContext(ownerKey, {
          version: 1,
          records: [...(draft.context?.records ?? []), record],
        });
        setSelection({ start: result.cursor, end: result.cursor });
        return;
      }

      if (
        item.type === "provider-slash-command" &&
        item.command.name === USAGE_LIMITS_COMMAND.name &&
        onUsageLimits
      ) {
        const cleared = replaceTextRange(draftMessage, trigger.rangeStart, trigger.rangeEnd, "");
        setSelection({ start: cleared.cursor, end: cleared.cursor });
        onChangeDraftMessage(cleared.text);
        onUsageLimits();
        return;
      }

      const result = resolveComposerCommandSelection({
        draftMessage,
        trigger,
        item,
        allowInteractionMode:
          onUpdateInteractionMode !== undefined &&
          selectedProviderStatus?.showInteractionModeToggle !== false,
        threadTitle,
      });
      setSelection({ start: result.cursor, end: result.cursor });
      onChangeDraftMessage(result.text);
      if (result.interactionMode !== null) {
        onUpdateInteractionMode?.(result.interactionMode);
      }
    },
    [
      draftMessage,
      ownerKey,
      items,
      onChangeDraftMessage,
      onUpdateInteractionMode,
      onUsageLimits,
      selectedProviderStatus?.showInteractionModeToggle,
      threadTitle,
      trigger,
    ],
  );

  return {
    selection,
    onSelectionChange,
    trigger,
    items,
    isLoading:
      trigger?.kind === "pull-request" ? pullRequestSearch.isPending : pathSearch.isPending,
    error:
      trigger?.kind === "pull-request"
        ? pullRequestProjectId === null || pullRequestRepository === null
          ? "Pull requests are unavailable for this project."
          : pullRequestSearch.error
        : null,
    onSelect,
  };
}
