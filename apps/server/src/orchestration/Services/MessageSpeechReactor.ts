import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface MessageSpeechReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class MessageSpeechReactor extends Context.Service<
  MessageSpeechReactor,
  MessageSpeechReactorShape
>()("t3/orchestration/Services/MessageSpeechReactor") {}
