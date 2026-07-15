# Conversation Forking for Codex and Claude

## Goal

Add a private-fork-friendly conversation action that creates a new T3 thread from the latest completed
state of an existing Codex or Claude conversation. The destination stays in the same environment and
project, preserves the source provider instance/model/runtime/workspace settings, and receives an
independent native provider session. The source thread is never resumed, stopped, rebound, or modified.

The forked T3 transcript only needs the source user and assistant text messages. Tool activities,
approvals, plans, checkpoints, diffs, terminals, and attachment files are intentionally not copied.

## Constraints and accepted tradeoffs

- Support only Codex and Claude Agent provider instances.
- Fork only the latest state; there is no per-message fork picker.
- Reject the action while the source session is `starting` or `running`, has an active turn, or its latest
  turn is still running. A destination in `starting` state cannot accept a turn until provider forking
  succeeds or fails.
- Use the same project, environment/machine, provider instance, model selection, runtime mode,
  interaction mode, branch, worktree path, and effective cwd.
- The destination title is `<source title> (fork)`; normal rename remains available.
- Copy only non-streaming `user` and `assistant` message text. Preserve ordering/timestamps and turn IDs,
  generate deterministic destination-specific message IDs, and drop attachments.
- Do not copy T3 activities, proposed plans, checkpoints, diffs, terminal state, unread state, or drafts.
- No automatic retry/outbox/saga. A failed provider fork leaves a visible destination thread in `error`
  state and cannot accept turns or be forked again; the UI shows the error, and the user may delete it and
  fork the source again. A native provider
  fork or provider binding left orphaned by a later persistence failure is accepted for this private build.
- If the server exits after committing the request but before the transient reactor runs, the destination
  may remain `starting` indefinitely. It must remain deletable; restarting/replaying incomplete fork work is
  intentionally out of scope.
- Keep changes narrow and additive. Avoid migrations or lineage fields unless implementation proves they
  are required. The `thread.fork-requested` event itself records source/destination lineage in the event log.
- Same-worktree concurrency is accepted.

## Design

### Command and event flow

1. The shared client command generates a destination `ThreadId` and dispatches `thread.fork` with:
   `threadId` (destination), `sourceThreadId`, `commandId`, and `createdAt`.
2. The decider validates that the source exists, is not archived/deleted, uses Codex or Claude, is idle,
   has an existing projected provider session, and the destination ID is unused.
3. In one orchestration transaction it emits, in order:
   - `thread.created` for the destination, copying source metadata;
   - `thread.session-set` for the destination with status `starting` and the source provider identity.
   - `thread.fork-requested` with source and destination IDs.
4. The projection pipeline handles `thread.fork-requested` by copying only source user/assistant message
   rows into the destination. It remaps message IDs deterministically, preserves text/order/timestamps and
   nullable turn IDs, forces `isStreaming=false`, and stores no attachments. Because command processing and
   projection writes are transactional and serialized, this captures the source at the accepted fork point
   and remains reproducible during projection replay.
5. The existing provider command reactor consumes `thread.fork-requested`, calls
   `ProviderService.forkConversation`, and
   then dispatches `thread.session.set`:
   - success: destination status `stopped` with the same provider instance and no active turn; its persisted
     provider binding contains the new native resume cursor, so the first prompt resumes the fork;
   - failure: destination status `error` with a concise provider error. No retry is attempted.
6. Web and iOS navigate to the known destination ID after the initial command succeeds. Existing session
   status UI disables sending while `starting`; web displays the normal error banner, and iOS shows an alert
   if the asynchronous provider fork fails.

### Provider API

Extend the existing provider adapter/service contracts with one narrow operation:

```ts
forkSession(input: {
  sourceThreadId: ThreadId;
  destinationThreadId: ThreadId;
  sourceResumeCursor: unknown;
  cwd?: string;
  modelSelection?: ModelSelection;
  runtimeMode: RuntimeMode;
}): Effect<ProviderForkResult, ProviderAdapterError>

type ProviderForkResult = {
  resumeCursor: unknown;
}
```

`ProviderService.forkConversation` reads the source binding from `ProviderSessionDirectory` without
recovering or mutating the source session, routes to the same provider instance, calls the adapter, and
upserts a destination binding with the returned cursor plus copied source runtime payload (cwd/model
selection), explicitly setting the provider-directory binding status to `stopped` rather than relying on
its new-binding default. It rejects missing resume state and adapters without the optional `forkSession`
operation. Immediately before the native fork, it also rejects a source adapter session whose live status
is anything other than idle/`ready`, narrowing the turn-start race without changing normal turn projection.
A dedicated result avoids pretending that the one-shot fork is an active `ProviderSession` and avoids mixing
provider runtime statuses with orchestration's `stopped` status.

- **Codex:** extend `CodexSessionRuntimeOptions` with a mutually exclusive fork source cursor. After
  initialize, open with `thread/fork` instead of `thread/start`/`thread/resume`, capture the returned native
  thread ID, then close the short-lived destination runtime. The one-shot runtime is never registered in
  the adapter session map and never starts its normal event fiber, so `hasSession(destinationThreadId)` stays
  false. Return `{ resumeCursor: { threadId: newNativeThreadId } }`. This works even when the source T3
  session is inactive and does not touch the source runtime.
- **Claude:** run the SDK's `forkSession(sourceSessionId, { dir: cwd })` in a short-lived Node process with
  the selected Claude instance's configured environment, including custom `HOME`, using the UUID from the
  source resume cursor. Return a fork result whose cursor resumes the returned session ID. Do not use plain
  `resume`, which would continue the source conversation.

### Client surfaces

- **Shared client runtime:** add `forkThread`; generate/return the destination ID and serialize it using the
  source thread as the command scheduling key. Server-side pending-turn state remains authoritative because
  client serialization ends when a turn-start command is accepted, not when the provider turn finishes.
- **Web:** add `Fork conversation` to the existing sidebar thread context menu and implement it through
  `useThreadActions`. Hide or disable it for unsupported providers and busy threads. On success, route to the
  destination; on command rejection, show the standard toast.
- **iOS:** add a `Fork conversation` native header action on `ThreadRouteScreen`, reusing the same shared
  command. Disable it for unsupported providers and busy threads. On success, replace/push the destination
  `Thread` route; on rejection, show an `Alert`. Do not add row swipe/context-menu plumbing in the first
  version, keeping the mobile diff localized.

## Implementation tasks

### 1. Add fork contracts and shared client command

- Update `packages/contracts/src/orchestration.ts` with `thread.fork`,
  `thread.fork-requested`, and their payload schemas. Add only the internal completion shape actually needed
  by the reactor; prefer the existing `thread.session.set` internal command for success/failure state.
- Update `packages/client-runtime/src/operations/commands.ts` so `forkThread` generates a destination thread
  ID and returns it with the dispatch result.
- Add `fork` to `packages/client-runtime/src/state/threadCommands.ts`, keyed by
  `(environmentId, sourceThreadId)` rather than destination ID.
- Add the command-shape test in `packages/client-runtime/src/operations/commands.test.ts` and the source-lane
  serialization assertion beside the scheduler in `packages/client-runtime/src/state/threadCommands.test.ts`.

### 2. Decide and project the T3 fork

- Update `apps/server/src/orchestration/commandInvariants.ts` with a small reusable idle-thread guard.
- Update `apps/server/src/orchestration/decider.ts` to emit the destination creation, fork request, and
  starting session events atomically. Add a guard to `thread.turn.start` that rejects destinations whose
  session is `starting`, preventing an accidental fresh provider session before the fork finishes.
- Keep normal `thread.turn-start-requested` projection unchanged. Revalidate the source adapter's live
  session state in `ProviderService.forkConversation` immediately before the native fork so a race does not
  create a durable `starting` marker that could strand ordinary turns after a server restart.
- Add a narrow `copyTextMessagesForFork` repository operation to
  `apps/server/src/persistence/Services/ProjectionThreadMessages.ts` and
  `apps/server/src/persistence/Layers/ProjectionThreadMessages.ts`. Implement it as one `INSERT ... SELECT`
  that filters user/assistant rows, drops attachments, and derives deterministic destination message IDs.
- Invoke that operation from `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` when projecting
  `thread.fork-requested`, then refresh the destination shell summary.
- Add one projection/decider test covering metadata inheritance, text-message copying, dropped activities
  and attachments, rejection of a projected running source, and provider-side rejection when the live
  adapter reports a running source.

### 3. Add provider-neutral fork routing

- Add the adapter input/result contract and an optional `forkSession` operation in
  `apps/server/src/provider/Services/ProviderAdapter.ts`. Do not add capability fields or unsupported stubs
  to every other adapter; method presence is sufficient for this private Codex/Claude-only feature.
- Add `forkConversation` to `apps/server/src/provider/Services/ProviderService.ts` and implement it in
  `apps/server/src/provider/Layers/ProviderService.ts` by reading the source binding and persisting the
  destination binding. Do not recover the source session.
- Report unsupported providers as a typed validation error so clients get a useful failure message.
- Add one provider-service test proving that source and destination bindings retain distinct resume cursors
  and the source binding is unchanged. Assert that the destination binding status is `stopped`.

### 4. Implement Codex and Claude forks

- Extend `apps/server/src/provider/Layers/CodexSessionRuntime.ts` with the `thread/fork` open mode and expose
  the resulting cursor without sending a turn.
- Implement adapter `forkSession` in `apps/server/src/provider/Layers/CodexAdapter.ts` using a short-lived
  unregistered destination runtime, then close its full scope while retaining its new resume cursor. Do not
  add it to `sessions` or launch the normal adapter event fiber.
- Implement adapter `forkSession` in `apps/server/src/provider/Layers/ClaudeAdapter.ts` using the installed
  Claude Agent SDK `forkSession` function and source UUID cursor.
- Leave other adapters unchanged; `ProviderService` reports the missing optional operation as unsupported.
- Add one focused native-call test per supported adapter. Avoid expanding the full provider test matrix.
  The Codex test must also assert `hasSession(destinationThreadId) === false` after scope closure.

### 5. React to fork requests and expose failure state

- Extend the existing `ProviderCommandReactor` request-event -> provider side effect -> internal command
  path with the fork request, avoiding a new service and startup layer for one private-build operation.
- On success, dispatch `thread.session.set` with status `stopped`; on failure, dispatch it with status
  `error` and a fork-specific provider error marker. Reject turns and repeat forks from that incomplete
  destination. Do not append tool/activity history or schedule retries.
- Wire the layer into the existing `OrchestrationReactor` startup and scoped-finalization lifecycle. Expose
  `drain` only if useful to the focused reactor test; do not add a new shutdown-drain path.
- Add one reactor test with a success and failure case. The success assertion must verify that no operation
  targets or mutates the source provider session.

### 6. Add web and iOS actions

- Web: extend `apps/web/src/hooks/useThreadActions.ts` and the thread context menu in
  `apps/web/src/components/Sidebar.tsx`. Navigate with the existing thread route helper.
- iOS: add the mutation and a single native header action in
  `apps/mobile/src/features/threads/ThreadRouteScreen.tsx`; reuse the existing session status/provider fields
  to determine availability and use the existing `Thread` route for navigation.
- Keep the action unavailable while busy, and surface command failures through existing toast/alert styles.
- Perform manual smoke checks on web and iOS rather than adding broad presentation tests.

## Verification

Focused automated checks:

- Run the new/changed contracts, command, projection, provider-service, adapter, and reactor test files with
  `vp test <paths>`.
- `vp check`
- `vp run typecheck`
- `vp run lint:mobile` because `ThreadRouteScreen.tsx` changes.

Manual smoke checks:

1. Fork an idle Codex thread from web; confirm copied user/assistant text, same metadata, new provider cursor,
   successful independent follow-up prompts, and unchanged source history/cursor.
2. Repeat with Claude.
3. Confirm a running conversation cannot be forked, including when the live adapter reports a running turn
   before the orchestration projection catches up.
4. Force a provider fork failure; confirm the destination remains visible with an error and the source still
   works.
5. Repeat the happy path from iOS and confirm navigation to the destination.
6. Stop the server with a destination still `starting`; after restart, confirm the stuck destination can be
   deleted even though it is not automatically retried, and confirm deletion does not recover or start its
   missing destination provider session.

## Known private-build limitations

- A second client could still start a source turn in the very small interval between the provider service's
  live-state recheck and the native fork call. If this becomes noticeable, add an explicit source-side fork
  lock in a later iteration rather than changing global turn projection.
- Native provider artifacts or destination bindings may remain orphaned after partial failure. They are not
  visible unless the T3 destination was created, and cleanup/retry machinery is intentionally out of scope.
- Historical attachments are not shown in the destination T3 transcript, though the native provider fork
  retains its own conversation context.
