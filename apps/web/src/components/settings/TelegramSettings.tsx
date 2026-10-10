import type { EnvironmentId, ServerSettingsPatch } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

type TelegramPatch = NonNullable<ServerSettingsPatch["telegram"]>;

/** A one-time code the bot accepts in `/start <code>` to learn the owner's chat. */
function createLinkCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function botStartUrl(botUsername: string, linkCode: string): string {
  return `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(linkCode)}`;
}

/** Telegram dispatches for the selected environment's server. */
export function TelegramIntegrationSettings() {
  const { environment: selected } = useSettingsScope();
  const environmentId =
    selected?.connection.phase === "connected" && selected.serverConfig !== null
      ? selected.environmentId
      : null;

  return (
    <SettingsSection id="telegram" title="Telegram">
      <SettingsRow
        {...searchableSetting("telegram-bot")}
        description="Agents can send summaries, reports, and voice notes to your Telegram bot, one topic per thread. Create a bot with @BotFather, enable Threaded Mode for it, then paste its token here."
      >
        {environmentId ? (
          // Drafts belong to one environment; switching must not carry them over.
          <TelegramBotForm key={environmentId} environmentId={environmentId} />
        ) : (
          <p className="pb-3 text-xs text-muted-foreground">
            Connect an environment to set up its Telegram bot.
          </p>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}

/**
 * The bot token is write-only: the server keeps it in its secret store and
 * only reports that one is saved. Linking writes a one-time code the bot
 * matches against `/start <code>`; the server then stores the chat id.
 */
function TelegramBotForm({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.telegram);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save Telegram settings",
  });
  const [tokenDraft, setTokenDraft] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [saving, setSaving] = useState(false);
  const tokenSaved = saved.botToken.length > 0;
  const newToken = tokenDraft.trim();
  const editingToken = !tokenSaved || replacing;

  const save = async (telegram: TelegramPatch): Promise<boolean> => {
    setSaving(true);
    try {
      const result = await updateSettings({ environmentId, input: { patch: { telegram } } });
      return result._tag === "Success";
    } finally {
      setSaving(false);
    }
  };

  const saveToken = async () => {
    if (await save({ botToken: newToken })) {
      setTokenDraft("");
      setReplacing(false);
    }
  };

  const linkChat = async (botUsername: string) => {
    const linkCode = createLinkCode();
    const url = botStartUrl(botUsername, linkCode);
    // Browsers block tabs opened after an await, so the web build reserves one
    // while the server records the code.
    const pending = window.desktopBridge ? null : window.open("", "_blank");
    if (pending) pending.opener = null;
    if (!(await save({ linkCode }))) {
      pending?.close();
      return;
    }
    if (pending) pending.location.href = url;
    else await ensureLocalApi().shell.openExternal(url);
  };

  if (editingToken) {
    return (
      <form
        className="flex flex-wrap items-center gap-2 pb-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (newToken) void saveToken();
        }}
      >
        <Input
          type="password"
          autoComplete="off"
          size="sm"
          aria-label="Telegram bot token"
          placeholder="Bot token from @BotFather"
          className="min-w-0 flex-1"
          disabled={saving}
          value={tokenDraft}
          onChange={(event) => setTokenDraft(event.target.value)}
        />
        {replacing ? (
          <Button
            size="xs"
            variant="outline"
            disabled={saving}
            onClick={() => {
              setTokenDraft("");
              setReplacing(false);
            }}
          >
            Cancel
          </Button>
        ) : null}
        <Button type="submit" size="xs" disabled={!newToken || saving}>
          Save
        </Button>
      </form>
    );
  }

  const linked = saved.chatId.length > 0;
  const waiting = !linked && saved.linkCode.length > 0 && saved.botUsername.length > 0;
  return (
    <div className="grid gap-3 pb-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Token saved
          {saved.botUsername ? (
            <>
              {" "}
              for <span className="text-foreground">@{saved.botUsername}</span>
            </>
          ) : (
            ". Waiting for the server to reach the bot…"
          )}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button size="xs" variant="outline" disabled={saving} onClick={() => setReplacing(true)}>
            Replace
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={saving}
            onClick={() => void save({ botToken: "", chatId: "", linkCode: "" })}
          >
            Remove
          </Button>
        </div>
      </div>
      {saved.botUsername ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {linked ? (
              "Linked to your Telegram chat."
            ) : waiting ? (
              <>
                Waiting for /start in Telegram…{" "}
                <InlineButton
                  render={
                    <a
                      href={botStartUrl(saved.botUsername, saved.linkCode)}
                      target="_blank"
                      rel="noreferrer noopener"
                    />
                  }
                >
                  Open the bot
                  <ExternalLinkIcon aria-hidden className="size-3" />
                </InlineButton>
              </>
            ) : (
              "Link your Telegram chat so the bot knows where to send."
            )}
          </p>
          {linked ? (
            <Button
              size="xs"
              variant="outline"
              disabled={saving}
              onClick={() => void save({ chatId: "" })}
            >
              Unlink
            </Button>
          ) : (
            <Button size="xs" disabled={saving} onClick={() => void linkChat(saved.botUsername)}>
              {waiting ? "New link" : "Link chat"}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
