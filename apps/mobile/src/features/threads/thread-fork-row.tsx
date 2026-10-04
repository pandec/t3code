import { useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { Pressable, type ColorValue } from "react-native";
import { resolveForkDivider } from "../../lib/threadActivity";
import { useThreadShell } from "../../state/entities";
import { ThreadContextDivider } from "./thread-context-divider";

/** Fork boundary divider; names the related thread when its shell is known and opens it on tap. */
export function ThreadForkRow(props: {
  environmentId: EnvironmentId;
  item: Extract<OrchestrationV2TurnItem, { type: "fork" }>;
  iconColor: ColorValue;
}) {
  const navigation = useNavigation();
  const divider = resolveForkDivider(props.item);
  const related = useThreadShell(scopeThreadRef(props.environmentId, divider.relatedThreadId));
  const relatedTitle = related?.title.trim();
  const label =
    props.item.source.type === "run" && relatedTitle
      ? `Forked from ${relatedTitle}`
      : divider.label;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      accessibilityHint={divider.actionLabel}
      onPress={() =>
        navigation.navigate("Thread", {
          environmentId: props.environmentId,
          threadId: divider.relatedThreadId,
        })
      }
    >
      <ThreadContextDivider
        label={label}
        icon="arrow.triangle.branch"
        iconColor={props.iconColor}
      />
    </Pressable>
  );
}
