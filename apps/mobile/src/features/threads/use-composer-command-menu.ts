import type {
  EnvironmentId,
  ProviderInteractionMode,
  ServerProvider,
  ServerProviderSkill,
} from "@t3tools/contracts";
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
import { useComposerPathSearch } from "../../state/queries";
import type { ComposerCommandItem } from "./ComposerCommandPopover";
import { matchesSlashSkillQuery } from "./composerSlashSkillSearch";

export function composerSelectionAtEnd(draftMessage: string): ComposerEditorSelection {
  return { start: draftMessage.length, end: draftMessage.length };
}

export function buildComposerSlashCommandItems(input: {
  readonly query: string;
  readonly atMessageStart: boolean;
  readonly hasThread: boolean;
  readonly hasCompactableConversation?: boolean;
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
  selectedProviderStatus,
  providerSkills,
  hasThread,
  threadTitle,
  hasCompactableConversation,
  enabled = true,
  onChangeDraftMessage,
  onUpdateInteractionMode,
}: {
  readonly draftMessage: string;
  readonly ownerKey: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly projectCwd: string | null;
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
  readonly enabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onUpdateInteractionMode?: (mode: ProviderInteractionMode) => void;
}) {
  const [selection, setSelection] = useState(() => composerSelectionAtEnd(draftMessage));
  const previousOwnerKeyRef = useRef(ownerKey);
  const onSelectionChange = useCallback((nextSelection: ComposerEditorSelection) => {
    setSelection(nextSelection);
  }, []);
  useEffect(() => {
    const end = draftMessage.length;
    setSelection((current) => {
      const start = Math.min(current.start, end);
      const selectionEnd = Math.min(current.end, end);
      if (start === current.start && selectionEnd === current.end) {
        return current;
      }
      return { start, end: selectionEnd };
    });
  }, [draftMessage.length]);
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

  const items = useMemo<ComposerCommandItem[]>(() => {
    if (!trigger) return [];

    if (trigger.kind === "slash-command") {
      const q = trigger.query.toLowerCase();
      const commandItems = buildComposerSlashCommandItems({
        query: q,
        atMessageStart: trigger.rangeStart === 0,
        hasThread,
        hasCompactableConversation,
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
    selectedProviderStatus,
    trigger,
  ]);

  const onSelect = useCallback(
    (item: ComposerCommandItem) => {
      if (!trigger) return;

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
      onChangeDraftMessage,
      onUpdateInteractionMode,
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
    isLoading: pathSearch.isPending,
    onSelect,
  };
}
