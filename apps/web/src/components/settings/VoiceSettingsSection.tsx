import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  type TtsProfileSettings,
  type TtsProfileSettingsPatch,
} from "@t3tools/contracts/settings";
import {
  TTS_PROVIDER_LABELS,
  TTS_TEST_MAX_TEXT_CHARS,
  type EnvironmentId,
  type TtsCatalogResult,
  type TtsProfile,
  type TtsProvider,
  type TtsTestResult,
} from "@t3tools/contracts";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DraftInput } from "../ui/draft-input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  describeCatalogModel,
  describeTestCost,
  findCatalogModel,
  resolveDisplayedTtsProfile,
  TTS_TEST_SAMPLE_TEXT,
  voicesForModel,
  voiceIdAfterModelChange,
} from "./VoiceSettings.logic";

const TTS_PROVIDERS: ReadonlyArray<TtsProvider> = ["openrouter", "elevenlabs"];

function useTtsCatalog(environmentId: EnvironmentId | null, provider: TtsProvider) {
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.ttsCatalog({ environmentId, input: { provider } }),
  );
}

function useTtsStatus(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.ttsStatus({ environmentId, input: {} }),
  );
}

/**
 * Provider, model, and voice selects for one profile. Models and voices come
 * from the server's catalog RPC; a stored id the catalog no longer lists is
 * still shown so the user can see what will be used and change it.
 */
function TtsProfileFields({
  idPrefix,
  profile,
  onPatch,
  environmentId,
  disabled = false,
}: {
  readonly idPrefix: string;
  readonly profile: TtsProfileSettings;
  readonly onPatch: (patch: TtsProfileSettingsPatch) => void;
  readonly environmentId: EnvironmentId | null;
  readonly disabled?: boolean;
}) {
  const status = useTtsStatus(environmentId);
  const catalog = useTtsCatalog(environmentId, profile.provider);
  const resolved = resolveDisplayedTtsProfile(
    profile,
    status.data?.[profile.provider].defaults ?? null,
  );
  if (resolved === null) {
    return (
      <p className="text-xs text-muted-foreground">
        {status.error ? "Voice defaults unavailable" : "Loading voice defaults…"}
      </p>
    );
  }
  const model = findCatalogModel(catalog.data, resolved.modelId);
  const voices = voicesForModel(catalog.data, model);
  const modelKnown = model !== null;
  const voiceKnown = voices.some((voice) => voice.id === resolved.voiceId);
  const modelDetail = describeCatalogModel(model);
  const catalogNote =
    catalog.error !== null
      ? "Catalog unavailable"
      : catalog.data !== null && !catalog.data.configured
        ? `${TTS_PROVIDER_LABELS[profile.provider]} has no key on this server`
        : (catalog.data?.error ?? null);
  const providerConfigured = (provider: TtsProvider) =>
    status.data === null ? true : status.data[provider].configured;

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-provider`}>Provider</Label>
        <Select
          value={profile.provider}
          onValueChange={(next) => {
            if (next === null || next === profile.provider) return;
            // Model and voice ids are provider-specific; a switch resets both
            // to the new provider's defaults rather than carrying stale ids.
            onPatch({ provider: next as TtsProvider, modelId: "", voiceId: "" });
          }}
          disabled={disabled}
        >
          <SelectTrigger id={`${idPrefix}-provider`} size="sm" className="w-full sm:w-72">
            <SelectValue>{TTS_PROVIDER_LABELS[profile.provider]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {TTS_PROVIDERS.map((provider) => (
              <SelectItem key={provider} value={provider}>
                <span className="flex w-full items-center justify-between gap-4">
                  <span>{TTS_PROVIDER_LABELS[provider]}</span>
                  {!providerConfigured(provider) ? (
                    <span className="text-xs text-muted-foreground">no key</span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-model`}>Model</Label>
        <Select
          value={resolved.modelId}
          onValueChange={(next) => {
            if (next === null || next === profile.modelId) return;
            onPatch({
              modelId: next,
              voiceId: voiceIdAfterModelChange(catalog.data, next, resolved.voiceId),
            });
          }}
          disabled={disabled}
        >
          <SelectTrigger id={`${idPrefix}-model`} size="sm" className="w-full sm:w-72">
            <SelectValue>{model?.name ?? resolved.modelId}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false} className="min-w-72">
            {!modelKnown ? (
              <SelectItem value={resolved.modelId}>{resolved.modelId}</SelectItem>
            ) : null}
            {(catalog.data?.models ?? []).map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                <span className="flex w-full items-center justify-between gap-4">
                  <span className="truncate">{entry.name}</span>
                  {entry.priceUsdPerMillionChars !== null ? (
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      ${entry.priceUsdPerMillionChars}/1M
                    </span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {modelDetail !== null || catalogNote !== null ? (
          <p className="text-xs text-muted-foreground">
            {catalogNote ?? modelDetail}
            {catalog.isPending ? " · loading…" : ""}
          </p>
        ) : null}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-voice`}>Voice</Label>
        <Select
          value={resolved.voiceId}
          onValueChange={(next) => {
            if (next === null || next === profile.voiceId) return;
            onPatch({
              voiceId: next,
            });
          }}
          disabled={disabled}
        >
          <SelectTrigger id={`${idPrefix}-voice`} size="sm" className="w-full sm:w-72">
            <SelectValue>
              {voices.find((voice) => voice.id === resolved.voiceId)?.name ?? resolved.voiceId}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false} className="min-w-72">
            {!voiceKnown ? (
              <SelectItem value={resolved.voiceId}>{resolved.voiceId}</SelectItem>
            ) : null}
            {voices.map((voice) => (
              <SelectItem key={voice.id} value={voice.id}>
                <span className="flex w-full items-center justify-between gap-4">
                  <span className="truncate">{voice.name}</span>
                  {voice.detail !== undefined ? (
                    <span className="shrink-0 text-xs text-muted-foreground">{voice.detail}</span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      {model?.supportsInstructions !== false ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-instructions`}>Style instructions</Label>
          <DraftInput
            id={`${idPrefix}-instructions`}
            className="w-full sm:w-72"
            value={profile.instructions}
            onCommit={(next) => onPatch({ instructions: next })}
            placeholder="Optional, e.g. calm and unhurried"
            disabled={disabled}
            aria-label="Style instructions"
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Synthesizes a sample with the current selection so a model or voice can
 * be judged before it is used on a real message. The audio never leaves the
 * dialog: it plays from a blob URL that is revoked when the dialog closes.
 */
function TtsTestDialog({
  open,
  onOpenChange,
  environmentId,
  profile,
  catalog,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly profile: TtsProfile;
  readonly catalog: TtsCatalogResult | null;
}) {
  const testTts = useAtomCommand(serverEnvironment.testTts, { reportFailure: false });
  const [text, setText] = useState(TTS_TEST_SAMPLE_TEXT);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<TtsTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const replaceAudio = useCallback((next: string | null) => {
    setAudioUrl((previous) => {
      if (previous !== null) URL.revokeObjectURL(previous);
      return next;
    });
  }, []);

  useEffect(() => {
    if (open) return;
    replaceAudio(null);
    setResult(null);
    setError(null);
  }, [open, replaceAudio]);

  useEffect(() => () => replaceAudio(null), [replaceAudio]);

  const generate = useCallback(async () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || pending) return;
    setPending(true);
    setError(null);
    const outcome = await testTts({ environmentId, input: { profile, text: trimmed } });
    setPending(false);
    if (outcome._tag === "Failure") {
      replaceAudio(null);
      setResult(null);
      setError(formatEnvironmentQueryError(outcome.cause));
      return;
    }
    const bytes = Uint8Array.from(atob(outcome.value.audioBase64), (char) => char.charCodeAt(0));
    replaceAudio(URL.createObjectURL(new Blob([bytes], { type: outcome.value.mimeType })));
    setResult(outcome.value);
    // Play once the element has the new source.
    queueMicrotask(() => void audioRef.current?.play().catch(() => undefined));
  }, [environmentId, pending, profile, replaceAudio, testTts, text]);

  const model = findCatalogModel(catalog, profile.modelId);
  const voiceName =
    voicesForModel(catalog, model).find((voice) => voice.id === profile.voiceId)?.name ??
    profile.voiceId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Test text-to-speech</DialogTitle>
          <DialogDescription>
            {TTS_PROVIDER_LABELS[profile.provider]} · {model?.name ?? profile.modelId} · {voiceName}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="tts-test-text">Sample text</Label>
              <Textarea
                id="tts-test-text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                maxLength={TTS_TEST_MAX_TEXT_CHARS}
                rows={5}
                disabled={pending}
              />
              <p className="text-xs text-muted-foreground">
                {text.trim().length.toLocaleString()} / {TTS_TEST_MAX_TEXT_CHARS.toLocaleString()}{" "}
                chars
                {model?.priceUsdPerMillionChars !== null &&
                model?.priceUsdPerMillionChars !== undefined
                  ? ` · ${describeCatalogModel(model)}`
                  : ""}
              </p>
            </div>
            {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
            {audioUrl !== null && result !== null ? (
              <div className="grid gap-1.5">
                <audio ref={audioRef} controls src={audioUrl} className="w-full" />
                <p className="text-xs text-muted-foreground">
                  {describeTestCost({
                    cost: result.cost,
                    characterCount: result.characterCount,
                    model,
                  })}
                  {" · "}
                  {(result.sizeBytes / 1024).toFixed(0)} KB
                </p>
              </div>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={() => void generate()} disabled={pending || text.trim().length === 0}>
            {pending ? <Spinner /> : null}
            {result === null ? "Generate" : "Generate again"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function TestButton({
  environmentId,
  profile,
  disabled,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly profile: TtsProfileSettings;
  readonly disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const status = useTtsStatus(environmentId);
  const resolved = resolveDisplayedTtsProfile(
    profile,
    status.data?.[profile.provider].defaults ?? null,
  );
  const catalog = useTtsCatalog(environmentId, profile.provider);
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={disabled || environmentId === null || resolved === null}
      >
        Test
      </Button>
      {environmentId !== null && resolved !== null ? (
        <TtsTestDialog
          open={open}
          onOpenChange={setOpen}
          environmentId={environmentId}
          profile={resolved}
          catalog={catalog.data}
        />
      ) : null}
    </>
  );
}

function OpenRouterTtsKeyRow() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const status = useTtsStatus(primaryEnvironmentId);
  const configure = useAtomCommand(serverEnvironment.configureTtsOpenRouter);
  const pendingApplyRef = useRef<Promise<void>>(Promise.resolve());

  const apply = useCallback(
    (apiKey: string) => {
      const run = async () => {
        if (environments.length === 0) {
          toastManager.add({
            type: "warning",
            title: "No environments connected",
            description: "Connect an environment before saving the OpenRouter key.",
          });
          return;
        }
        // Speech runs on whichever server owns the thread, so the key goes to
        // every connected environment, like the credits management key.
        const results = await Promise.all(
          environments.map(async (environment) => ({
            label: environment.label,
            result: await configure({
              environmentId: environment.environmentId,
              input: { apiKey },
            }),
          })),
        );
        const failed = results
          .filter(({ result }) => result._tag === "Failure")
          .map(({ label }) => label);
        const removed = apiKey.trim().length === 0;
        if (failed.length === 0) {
          toastManager.add({
            type: "success",
            title: removed ? "OpenRouter speech key removed" : "OpenRouter speech key saved",
          });
          return;
        }
        toastManager.add({
          type: "warning",
          title: removed
            ? "Could not remove the key everywhere"
            : "Could not save the key everywhere",
          description: `Failed for: ${failed.join(", ")}.`,
        });
      };
      const chained = pendingApplyRef.current.then(run);
      pendingApplyRef.current = chained;
      return chained;
    },
    [configure, environments],
  );

  const configured = status.data?.openrouter.configured === true;
  const statusText =
    status.error !== null
      ? "Unavailable"
      : status.data === null
        ? ""
        : (status.data.openrouter.error ?? (configured ? "Key stored" : "No key"));

  return (
    <SettingsRow
      serverScoped
      title="OpenRouter speech key"
      description="A regular inference key from openrouter.ai/keys. Stored in each environment's secret store and only used server-side to synthesize speech. The credits management key does not work here."
      status={statusText}
      resetAction={
        configured ? (
          <SettingResetButton
            label="OpenRouter speech key"
            tooltip="Remove key"
            onClick={() => void apply("")}
          />
        ) : null
      }
      control={
        <DraftInput
          className="w-full sm:w-72"
          value=""
          onCommit={(next) => {
            const trimmed = next.trim();
            if (trimmed.length > 0) void apply(trimmed);
          }}
          type="password"
          autoComplete="off"
          placeholder={configured ? "Replace key" : "sk-or-…"}
          spellCheck={false}
          aria-label="OpenRouter speech key"
        />
      }
    />
  );
}

export function VoiceSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const status = useTtsStatus(primaryEnvironmentId);
  const providerConfigured = (provider: TtsProvider) =>
    status.data === null || status.data[provider].configured;

  const defaultProfile = settings.voice.tts;
  const override = settings.voice.agentReplyTts;
  const defaultDirty = useMemo(
    () =>
      defaultProfile.provider !== DEFAULT_UNIFIED_SETTINGS.voice.tts.provider ||
      defaultProfile.modelId !== "" ||
      defaultProfile.voiceId !== "" ||
      defaultProfile.instructions !== "",
    [defaultProfile],
  );

  return (
    <SettingsSection {...searchableSetting("extras-voice-listening")}>
      <OpenRouterTtsKeyRow />

      <SettingsRow
        serverScoped
        title="Text-to-speech"
        description="Provider, model, and voice used to read assistant messages aloud. ElevenLabs needs ELEVENLABS_API_KEY in the server's environment; OpenRouter uses the key above."
        resetAction={
          defaultDirty ? (
            <SettingResetButton
              label="text-to-speech"
              onClick={() =>
                updateSettings({
                  voice: {
                    tts: {
                      provider: DEFAULT_UNIFIED_SETTINGS.voice.tts.provider,
                      modelId: "",
                      voiceId: "",
                      instructions: "",
                    },
                  },
                })
              }
            />
          ) : null
        }
        control={
          <TestButton
            environmentId={primaryEnvironmentId}
            profile={defaultProfile}
            disabled={!providerConfigured(defaultProfile.provider)}
          />
        }
      >
        <div className="px-3 pb-3 sm:px-4">
          <TtsProfileFields
            idPrefix="tts-default"
            profile={defaultProfile}
            onPatch={(patch) => updateSettings({ voice: { tts: patch } })}
            environmentId={primaryEnvironmentId}
          />
        </div>
      </SettingsRow>

      <SettingsRow
        serverScoped
        {...searchableSetting("agent-voice-replies")}
        title="Agent voice replies"
        description="Give agents a voice_reply tool that answers with a spoken recording shown as the main message. Applies to sessions started from now on."
        resetAction={
          settings.voice.enableAgentVoiceReplies !==
          DEFAULT_UNIFIED_SETTINGS.voice.enableAgentVoiceReplies ? (
            <SettingResetButton
              label="agent voice replies"
              onClick={() =>
                updateSettings({
                  voice: {
                    enableAgentVoiceReplies: DEFAULT_UNIFIED_SETTINGS.voice.enableAgentVoiceReplies,
                  },
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.voice.enableAgentVoiceReplies}
            onCheckedChange={(checked) =>
              updateSettings({ voice: { enableAgentVoiceReplies: Boolean(checked) } })
            }
            aria-label="Allow agent voice replies"
          />
        }
      />

      <SettingsRow
        serverScoped
        title="Separate voice for agent replies"
        description="Use a different provider, model, or voice for agent voice replies than for message listening."
        resetAction={
          override !== null ? (
            <SettingResetButton
              label="separate voice for agent replies"
              onClick={() => updateSettings({ voice: { agentReplyTts: null } })}
            />
          ) : null
        }
        control={
          <div className="flex items-center gap-3">
            {override !== null ? (
              <TestButton
                environmentId={primaryEnvironmentId}
                profile={override}
                disabled={!providerConfigured(override.provider)}
              />
            ) : null}
            <Switch
              checked={override !== null}
              onCheckedChange={(checked) =>
                updateSettings({
                  voice: { agentReplyTts: checked ? {} : null },
                })
              }
              aria-label="Use a separate voice for agent replies"
            />
          </div>
        }
      >
        {override !== null ? (
          <div className="px-3 pb-3 sm:px-4">
            <TtsProfileFields
              idPrefix="tts-agent"
              profile={override}
              onPatch={(patch) => updateSettings({ voice: { agentReplyTts: patch } })}
              environmentId={primaryEnvironmentId}
            />
          </div>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
