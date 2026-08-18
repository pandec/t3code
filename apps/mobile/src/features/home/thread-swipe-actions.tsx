import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import type { MenuAction } from "@react-native-menu/menu";
import * as Haptics from "expo-haptics";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type {
  ColorValue,
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleProp,
  ViewStyle,
} from "react-native";
import { Pressable, View } from "react-native";
import ReanimatedSwipeable, {
  SwipeDirection,
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";

// Wide enough for the longest action label ("Unarchive").
const ACTION_ITEM_WIDTH = 58;
const ACTION_CIRCLE_SIZE = 36;
const ACTION_ICON_SIZE = 15;
const COMPACT_ACTION_CIRCLE_SIZE = 28;
const COMPACT_ACTION_ICON_SIZE = 13;

export const THREAD_SWIPE_ACTIONS_WIDTH = ACTION_ITEM_WIDTH * 2;
export const THREAD_SWIPE_SPRING = {
  damping: 26,
  mass: 0.7,
  overshootClamping: true,
  stiffness: 330,
};

interface ThreadSwipeAction {
  readonly accessibilityLabel: string;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly menu?: {
    readonly actions: MenuAction[];
    readonly onPressAction: NonNullable<ComponentProps<typeof ControlPillMenu>["onPressAction"]>;
    readonly title?: string;
  };
  readonly onPress: () => void;
}

interface ThreadSwipeSecondaryAction extends ThreadSwipeAction {
  readonly backgroundColor: string;
}

interface ThreadSwipeLeftAction extends ThreadSwipeAction {
  /** Defaults to the archive blue the single-action panel has always used. */
  readonly backgroundColor?: string;
}

/** The archive blue every leading action fell back to before the panel grew. */
const DEFAULT_LEFT_ACTION_COLOR = "#007aff";

function swipeActionsWidth(hasSecondaryAction: boolean) {
  return hasSecondaryAction ? THREAD_SWIPE_ACTIONS_WIDTH : ACTION_ITEM_WIDTH;
}

/** `undefined` keeps the v1 Delete default; `null` means one action only. */
function resolveSecondaryAction(input: {
  readonly close: () => void;
  readonly onDelete: () => void;
  readonly secondaryAction: ThreadSwipeAction | null | undefined;
  readonly threadTitle: string;
}): ThreadSwipeSecondaryAction | null {
  if (input.secondaryAction === null) return null;
  if (input.secondaryAction === undefined) {
    return {
      accessibilityLabel: `Delete ${input.threadTitle}`,
      backgroundColor: "#ff2d55",
      icon: "trash",
      label: "Delete",
      onPress: () => {
        input.close();
        input.onDelete();
      },
    };
  }
  const action = input.secondaryAction;
  return {
    ...action,
    backgroundColor: "#5856d6",
    menu:
      action.menu === undefined
        ? undefined
        : {
            ...action.menu,
            onPressAction: (event) => {
              input.close();
              action.menu?.onPressAction(event);
            },
          },
    onPress: () => {
      input.close();
      action.onPress();
    },
  };
}

/**
 * Delivers the scroll gate to swipeables via context so that flipping it does
 * NOT re-render whole rows: putting the flag in list extraData/renderItem deps
 * re-rendered every visible row (hooks, subscriptions and all) exactly at
 * scroll start — peak frame pressure. As a context value only the
 * ThreadSwipeable consumers re-render.
 */
const SwipeableScrollGateContext = createContext(true);

export function SwipeableScrollGateProvider(props: {
  readonly enabled: boolean;
  readonly children: ReactNode;
}) {
  return (
    <SwipeableScrollGateContext.Provider value={props.enabled}>
      {props.children}
    </SwipeableScrollGateContext.Provider>
  );
}

/**
 * Gates row swipes on list scroll activity, mirroring UIKit's own swipe
 * actions (`!isDragging && !isDecelerating`). failOffsetY on the swipe pan
 * covers the first pan of a scroll, but trackpad scroll sessions spawn fresh
 * gesture sessions (momentum catch, direction changes) whose reset
 * translation can re-activate a swipe mid-scroll — so while the list has
 * moved vertically during an active drag/momentum phase, row swipes are
 * disabled entirely.
 *
 * Spread the returned handlers onto the list and pass `swipeEnabled` to rows.
 */
export function useSwipeableScrollGate(options?: {
  readonly onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  readonly onScrollBeginDrag?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}) {
  const [gateActive, setGateActive] = useState(false);
  const gateActiveRef = useRef(false);
  const draggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const externalOnScroll = options?.onScroll;
  const externalOnScrollBeginDrag = options?.onScrollBeginDrag;

  const update = useCallback((next: boolean) => {
    if (gateActiveRef.current !== next) {
      gateActiveRef.current = next;
      setGateActive(next);
    }
  }, []);
  const clearSettle = useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);
  useEffect(() => clearSettle, [clearSettle]);

  const onScrollBeginDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      draggingRef.current = true;
      dragStartYRef.current = event.nativeEvent.contentOffset.y;
      clearSettle();
      externalOnScrollBeginDrag?.(event);
    },
    [clearSettle, externalOnScrollBeginDrag],
  );
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Only vertical movement during a user drag arms the gate — a purely
      // horizontal row swipe never moves contentOffset.y, and inset-driven
      // offset changes at mount happen outside a drag.
      if (
        draggingRef.current &&
        !gateActiveRef.current &&
        Math.abs(event.nativeEvent.contentOffset.y - dragStartYRef.current) > 4
      ) {
        update(true);
      }
      externalOnScroll?.(event);
    },
    [externalOnScroll, update],
  );
  const onScrollEndDrag = useCallback(() => {
    draggingRef.current = false;
    clearSettle();
    // If momentum follows, onMomentumScrollBegin cancels this and the gate
    // stays armed until the deceleration finishes.
    settleTimerRef.current = setTimeout(() => update(false), 160);
  }, [clearSettle, update]);
  const onMomentumScrollBegin = useCallback(() => {
    clearSettle();
  }, [clearSettle]);
  const onMomentumScrollEnd = useCallback(() => {
    update(false);
  }, [update]);

  return {
    swipeEnabled: !gateActive,
    scrollGateHandlers: {
      onScroll,
      onScrollBeginDrag,
      onScrollEndDrag,
      onMomentumScrollBegin,
      onMomentumScrollEnd,
    },
  };
}

export function ThreadSwipeable(props: {
  readonly backgroundColor: ColorValue;
  readonly children: (close: () => void) => ReactNode;
  /** Uses action visuals that fit inside compact 44pt rows. The press target
   * still spans the row's full height and width. */
  readonly compactActions?: boolean;
  readonly containerStyle?: StyleProp<ViewStyle>;
  /** Disables NEW swipe activations (e.g. while the list scrolls). */
  readonly enabled?: boolean;
  readonly enableTrackpadSwipe?: boolean;
  /**
   * What a full swipe commits. Omitted keeps the v1 Delete behavior only when
   * the built-in Delete secondary action is in use; custom or absent
   * secondary actions default to the advertised primary action.
   */
  readonly fullSwipeAction?: "delete" | "primary";
  readonly fullSwipeWidth: number;
  /**
   * Actions revealed by swiping right (on the row's left side), ordered from
   * the screen's leading edge inward: the first is uncovered by the shortest
   * swipe, the last sits against the row and is what a full swipe past the
   * threshold commits immediately.
   */
  readonly leftActions?: readonly ThreadSwipeLeftAction[];
  readonly onDelete: () => void;
  readonly onSwipeableClose?: (methods: SwipeableMethods) => void;
  readonly onSwipeableWillOpen?: (methods: SwipeableMethods) => void;
  readonly primaryAction: ThreadSwipeAction;
  /**
   * Omitted keeps the v1 destructive Delete action. Explicit null opts out of
   * a secondary action entirely so a gated Snooze can never fall back to an
   * unadvertised Delete.
   */
  readonly secondaryAction?: ThreadSwipeAction | null;
  /**
   * Identity of the content being wrapped. When a recycled list reuses this
   * component for a different item, the swipeable snaps back to closed so an
   * open/mid-drag state can't leak onto another row.
   */
  readonly resetKey?: string;
  readonly simultaneousWithExternalGesture?: ComponentProps<
    typeof ReanimatedSwipeable
  >["simultaneousWithExternalGesture"];
  readonly threadTitle: string;
}) {
  const swipeableRef = useRef<SwipeableMethods | null>(null);
  const fullSwipeArmedRef = useRef(false);
  const leftFullSwipeArmedRef = useRef(false);
  const leftActions = props.leftActions ?? [];
  const hasLeftActions = leftActions.length > 0;
  const leftActionsWidth = leftActions.length * ACTION_ITEM_WIDTH;
  // The innermost leading action owns the full swipe, so the panel keeps one
  // advertised default no matter how many actions precede it.
  const leftFullSwipeAction = leftActions[leftActions.length - 1];
  const hasSecondaryAction = props.secondaryAction !== null;
  const actionsWidth = swipeActionsWidth(hasSecondaryAction);
  const fullSwipeThreshold = Math.max(actionsWidth + 44, props.fullSwipeWidth * 0.58);
  const leftFullSwipeThreshold = Math.max(leftActionsWidth + 44, props.fullSwipeWidth * 0.58);
  const fullSwipeAction =
    props.fullSwipeAction ?? (props.secondaryAction === undefined ? "delete" : "primary");
  const close = useCallback(() => swipeableRef.current?.close(), []);
  const gateEnabled = use(SwipeableScrollGateContext);
  const resetKey = props.resetKey;
  useEffect(() => {
    if (resetKey === undefined) {
      return;
    }
    fullSwipeArmedRef.current = false;
    leftFullSwipeArmedRef.current = false;
    swipeableRef.current?.reset();
  }, [resetKey]);
  const handleFullSwipeArmedChange = useCallback((armed: boolean) => {
    if (armed && !fullSwipeArmedRef.current) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    fullSwipeArmedRef.current = armed;
  }, []);
  const handleLeftFullSwipeArmedChange = useCallback((armed: boolean) => {
    if (armed && !leftFullSwipeArmedRef.current) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    leftFullSwipeArmedRef.current = armed;
  }, []);

  return (
    <ReanimatedSwipeable
      ref={swipeableRef}
      animationOptions={THREAD_SWIPE_SPRING}
      childrenContainerStyle={{ backgroundColor: props.backgroundColor }}
      containerStyle={[{ backgroundColor: props.backgroundColor }, props.containerStyle]}
      // Rows without a left action keep the RNGH default so an inert pan
      // can't activate earlier than it used to.
      dragOffsetFromLeftEdge={hasLeftActions ? 8 : 10}
      dragOffsetFromRightEdge={8}
      enabled={props.enabled !== false && gateEnabled}
      enableTrackpadTwoFingerGesture={props.enableTrackpadSwipe ?? true}
      // Fail the swipe once the pan is vertically dominant (patched-in RNGH
      // prop) — otherwise trackpad scrolls with ~8px of horizontal drift
      // start opening rows because the swipe pan runs simultaneously with
      // the list scroll gesture and never gets disqualified by Y movement.
      failOffsetY={[-10, 10]}
      friction={1}
      onSwipeableClose={() => {
        fullSwipeArmedRef.current = false;
        leftFullSwipeArmedRef.current = false;
        if (swipeableRef.current) {
          props.onSwipeableClose?.(swipeableRef.current);
        }
      }}
      onSwipeableOpenStartDrag={() => {
        if (swipeableRef.current) {
          props.onSwipeableWillOpen?.(swipeableRef.current);
        }
      }}
      // A cross-direction drag from an already-open row can cross the
      // full-swipe threshold, but RNGH resolves that release to translation 0
      // so onSwipeableWillOpen never fires. Commit here so an armed swipe
      // (haptic already delivered) always keeps its promise. The refs are
      // cleared before close() on the normal commit paths, so this cannot
      // double-fire.
      onSwipeableWillClose={() => {
        if (leftFullSwipeArmedRef.current) {
          leftFullSwipeArmedRef.current = false;
          leftFullSwipeAction?.onPress();
          return;
        }
        if (fullSwipeArmedRef.current) {
          fullSwipeArmedRef.current = false;
          if (fullSwipeAction === "primary") {
            props.primaryAction.onPress();
          } else {
            props.onDelete();
          }
        }
      }}
      // RNGH reports the swipe direction, not the panel side: RIGHT means the
      // user swiped right, so the LEFT panel is what opened.
      onSwipeableWillOpen={(direction) => {
        const methods = swipeableRef.current;
        if (!methods) {
          return;
        }

        props.onSwipeableWillOpen?.(methods);
        if (direction === SwipeDirection.RIGHT) {
          if (leftFullSwipeArmedRef.current) {
            leftFullSwipeArmedRef.current = false;
            methods.close();
            leftFullSwipeAction?.onPress();
          }
          return;
        }
        if (fullSwipeArmedRef.current) {
          fullSwipeArmedRef.current = false;
          methods.close();
          if (fullSwipeAction === "primary") {
            props.primaryAction.onPress();
          } else {
            props.onDelete();
          }
        }
      }}
      overshootFriction={1}
      overshootLeft={hasLeftActions}
      overshootRight
      leftThreshold={leftActionsWidth * 0.42}
      renderLeftActions={
        hasLeftActions
          ? (_progress, translation, methods) => (
              <ThreadSwipeLeftActions
                actions={leftActions.map((action) => ({
                  ...action,
                  onPress: () => {
                    methods.close();
                    action.onPress();
                  },
                }))}
                backgroundColor={props.backgroundColor}
                compact={props.compactActions === true}
                fullSwipeThreshold={leftFullSwipeThreshold}
                onFullSwipeArmedChange={handleLeftFullSwipeArmedChange}
                translation={translation}
              />
            )
          : undefined
      }
      renderRightActions={(_progress, translation, methods) => (
        <ThreadSwipeActions
          backgroundColor={props.backgroundColor}
          compact={props.compactActions === true}
          fullSwipeAction={fullSwipeAction}
          fullSwipeThreshold={fullSwipeThreshold}
          onFullSwipeArmedChange={handleFullSwipeArmedChange}
          primaryAction={{
            ...props.primaryAction,
            onPress: () => {
              methods.close();
              props.primaryAction.onPress();
            },
          }}
          secondaryAction={resolveSecondaryAction({
            close: () => methods.close(),
            onDelete: props.onDelete,
            secondaryAction: props.secondaryAction,
            threadTitle: props.threadTitle,
          })}
          translation={translation}
        />
      )}
      rightThreshold={actionsWidth * 0.42}
      simultaneousWithExternalGesture={props.simultaneousWithExternalGesture}
    >
      {props.children(close)}
    </ReanimatedSwipeable>
  );
}

function SwipeActionButton(props: {
  readonly accessibilityLabel: string;
  readonly actionsWidth: number;
  readonly backgroundColor: string;
  readonly compact: boolean;
  readonly entryRange: readonly [number, number];
  readonly fullSwipeThreshold: number;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly menu?: ThreadSwipeAction["menu"];
  readonly onPress: () => void;
  /** Which panel hosts the button. The left panel mirrors every horizontal
   * motion: entry slides in from the left and the full-swipe stretch grows
   * toward the row's leading edge instead of away from it. */
  readonly side: "left" | "right";
  /** Distance from the panel's leading edge to this button. A stretching
   * left-panel button pulls its pill back over that gap so the fill starts at
   * the screen edge rather than mid-panel. Right-panel buttons anchor to the
   * screen edge already and always pass 0. */
  readonly stretchAnchorOffset?: number;
  readonly stretchesOnFullSwipe: boolean;
  readonly translation: SharedValue<number>;
}) {
  const circleSize = props.compact ? COMPACT_ACTION_CIRCLE_SIZE : ACTION_CIRCLE_SIZE;
  const iconSize = props.compact ? COMPACT_ACTION_ICON_SIZE : ACTION_ICON_SIZE;
  // Left-panel reveal grows with positive translation, right-panel with
  // negative; the stretch offset flips sign with it.
  const revealSign = props.side === "left" ? 1 : -1;
  const actionStyle = useAnimatedStyle(() => {
    const reveal = Math.max(revealSign * props.translation.value, 0);
    const entryProgress = interpolate(reveal, props.entryRange, [0, 1], Extrapolation.CLAMP);
    const stretch = Math.max(reveal - props.actionsWidth, 0);
    const fullSwipeProgress = interpolate(
      reveal,
      [props.actionsWidth, props.fullSwipeThreshold + 20],
      [0, 1],
      Extrapolation.CLAMP,
    );

    return {
      opacity: props.stretchesOnFullSwipe ? entryProgress : entryProgress * (1 - fullSwipeProgress),
      transform: [
        {
          translateX:
            interpolate(entryProgress, [0, 1], [-revealSign * 22, 0]) +
            revealSign * (props.stretchesOnFullSwipe ? 0 : stretch),
        },
        { scale: interpolate(entryProgress, [0, 1], [0.78, 1]) },
      ],
    };
  });
  const anchorOffset = props.side === "left" ? (props.stretchAnchorOffset ?? 0) : 0;
  const circleStyle = useAnimatedStyle(() => {
    const reveal = Math.max(revealSign * props.translation.value, 0);
    const stretch = props.stretchesOnFullSwipe ? Math.max(reveal - props.actionsWidth, 0) : 0;
    // Reaches back to the panel's leading edge, then stops — the pill never
    // slides past the screen edge it is filling toward.
    const anchorPull = Math.min(stretch, anchorOffset);

    return {
      // The circle widens toward the row: leftward on the right panel, and on
      // the left panel it grows rightward from its anchored left edge while
      // that edge settles onto the panel's start.
      transform: [{ translateX: props.side === "left" ? -anchorPull : -stretch }],
      width: circleSize + stretch + anchorPull,
    };
  });
  const iconStyle = useAnimatedStyle(() => {
    const reveal = Math.max(revealSign * props.translation.value, 0);
    const stretch = props.stretchesOnFullSwipe ? Math.max(reveal - props.actionsWidth, 0) : 0;
    const armedProgress = interpolate(
      reveal,
      [props.fullSwipeThreshold, props.fullSwipeThreshold + 20],
      [0, 1],
      Extrapolation.CLAMP,
    );

    return {
      transform: [{ translateX: revealSign * stretch * (0.5 + armedProgress * 0.5) }],
    };
  });
  const labelStyle = useAnimatedStyle(() => {
    if (!props.stretchesOnFullSwipe) {
      return { opacity: 1 };
    }

    const reveal = Math.max(revealSign * props.translation.value, 0);
    const stretch = Math.max(reveal - props.actionsWidth, 0);
    return {
      opacity: interpolate(
        reveal,
        [props.fullSwipeThreshold - 24, props.fullSwipeThreshold],
        [1, 0],
        Extrapolation.CLAMP,
      ),
      transform: [{ translateX: revealSign * stretch * 0.5 }],
    };
  });

  const button = (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      onPress={props.menu === undefined ? props.onPress : undefined}
      style={({ pressed }) => ({
        alignItems: "center",
        height: "100%",
        justifyContent: "center",
        opacity: pressed ? 0.72 : 1,
        width: "100%",
      })}
    >
      <View style={{ height: circleSize, width: circleSize }}>
        <Animated.View
          style={[
            {
              backgroundColor: props.backgroundColor,
              borderRadius: 999,
              height: circleSize,
              left: 0,
              position: "absolute",
              top: 0,
            },
            circleStyle,
          ]}
        />
        <Animated.View
          style={[
            {
              alignItems: "center",
              height: circleSize,
              justifyContent: "center",
              left: 0,
              position: "absolute",
              top: 0,
              width: circleSize,
            },
            iconStyle,
          ]}
        >
          <SymbolView name={props.icon} size={iconSize} tintColor="#ffffff" type="monochrome" />
        </Animated.View>
      </View>
      <Animated.View
        style={[
          { height: 14, justifyContent: "center", paddingTop: props.compact ? 0 : 2 },
          labelStyle,
        ]}
      >
        <Text className="text-3xs font-t3-medium text-foreground-muted" numberOfLines={1}>
          {props.label}
        </Text>
      </Animated.View>
    </Pressable>
  );

  return (
    <Animated.View
      style={[
        {
          alignItems: "center",
          height: "100%",
          justifyContent: "center",
          width: ACTION_ITEM_WIDTH,
          zIndex: props.stretchesOnFullSwipe ? 2 : 1,
        },
        actionStyle,
      ]}
    >
      {props.menu === undefined ? (
        button
      ) : (
        <ControlPillMenu
          actions={props.menu.actions}
          onPressAction={props.menu.onPressAction}
          title={props.menu.title}
          style={{ height: "100%", width: "100%" }}
        >
          {button}
        </ControlPillMenu>
      )}
    </Animated.View>
  );
}

/** The leading panel. Actions are laid out from the screen's leading edge
 * inward, so each one enters as the row uncovers it; only the innermost —
 * the full-swipe default — stretches, and the rest fade out under it. */
function ThreadSwipeLeftActions(props: {
  readonly actions: readonly ThreadSwipeLeftAction[];
  readonly backgroundColor: ColorValue;
  readonly compact: boolean;
  readonly fullSwipeThreshold: number;
  readonly onFullSwipeArmedChange: (armed: boolean) => void;
  readonly translation: SharedValue<number>;
}) {
  const actionsWidth = props.actions.length * ACTION_ITEM_WIDTH;
  useAnimatedReaction(
    () => props.translation.value >= props.fullSwipeThreshold,
    (armed, previous) => {
      if (armed !== previous) {
        runOnJS(props.onFullSwipeArmedChange)(armed);
      }
    },
    [props.fullSwipeThreshold, props.onFullSwipeArmedChange],
  );

  return (
    <View
      style={{
        backgroundColor: props.backgroundColor,
        flexDirection: "row",
        height: "100%",
        width: actionsWidth,
      }}
    >
      {props.actions.map((action, index) => {
        const offset = index * ACTION_ITEM_WIDTH;
        return (
          <SwipeActionButton
            key={action.label}
            accessibilityLabel={action.accessibilityLabel}
            actionsWidth={actionsWidth}
            backgroundColor={action.backgroundColor ?? DEFAULT_LEFT_ACTION_COLOR}
            compact={props.compact}
            entryRange={[offset + 8, offset + ACTION_ITEM_WIDTH * 0.72]}
            fullSwipeThreshold={props.fullSwipeThreshold}
            icon={action.icon}
            label={action.label}
            menu={action.menu}
            onPress={action.onPress}
            side="left"
            stretchAnchorOffset={offset}
            stretchesOnFullSwipe={index === props.actions.length - 1}
            translation={props.translation}
          />
        );
      })}
    </View>
  );
}

export function ThreadSwipeActions(props: {
  readonly backgroundColor: ColorValue;
  readonly compact: boolean;
  readonly fullSwipeAction?: "delete" | "primary";
  readonly fullSwipeThreshold: number;
  readonly onFullSwipeArmedChange: (armed: boolean) => void;
  readonly primaryAction: ThreadSwipeAction;
  readonly secondaryAction: ThreadSwipeSecondaryAction | null;
  readonly translation: SharedValue<number>;
}) {
  const secondaryAction = props.secondaryAction;
  const fullSwipeIsPrimary = props.fullSwipeAction === "primary" || secondaryAction === null;
  const actionsWidth = swipeActionsWidth(secondaryAction !== null);
  useAnimatedReaction(
    () => -props.translation.value >= props.fullSwipeThreshold,
    (armed, previous) => {
      if (armed !== previous) {
        runOnJS(props.onFullSwipeArmedChange)(armed);
      }
    },
    [props.fullSwipeThreshold, props.onFullSwipeArmedChange],
  );

  return (
    <View
      style={{
        backgroundColor: props.backgroundColor,
        flexDirection: "row",
        height: "100%",
        width: actionsWidth,
      }}
    >
      <SwipeActionButton
        accessibilityLabel={props.primaryAction.accessibilityLabel}
        actionsWidth={actionsWidth}
        backgroundColor="#007aff"
        compact={props.compact}
        entryRange={
          secondaryAction === null
            ? [8, ACTION_ITEM_WIDTH * 0.72]
            : [ACTION_ITEM_WIDTH * 0.55, THREAD_SWIPE_ACTIONS_WIDTH * 0.85]
        }
        fullSwipeThreshold={props.fullSwipeThreshold}
        icon={props.primaryAction.icon}
        label={props.primaryAction.label}
        onPress={props.primaryAction.onPress}
        side="right"
        stretchesOnFullSwipe={fullSwipeIsPrimary}
        translation={props.translation}
      />
      {secondaryAction === null ? null : (
        <SwipeActionButton
          accessibilityLabel={secondaryAction.accessibilityLabel}
          actionsWidth={actionsWidth}
          backgroundColor={secondaryAction.backgroundColor}
          compact={props.compact}
          entryRange={[8, ACTION_ITEM_WIDTH * 0.72]}
          fullSwipeThreshold={props.fullSwipeThreshold}
          icon={secondaryAction.icon}
          label={secondaryAction.label}
          menu={secondaryAction.menu}
          onPress={secondaryAction.onPress}
          side="right"
          stretchesOnFullSwipe={!fullSwipeIsPrimary}
          translation={props.translation}
        />
      )}
    </View>
  );
}
