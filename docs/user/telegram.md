# Telegram dispatches

Agents can send their results to Telegram: a short summary, an optional full report, and an optional voice note. Each T3 thread gets its own topic in a private chat with your bot, and you can answer from Telegram to keep the thread going.

## Connect a bot

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token it gives you.
2. In BotFather, open your bot's settings and turn on **Threaded Mode**, so the chat can hold one topic per thread.
3. In T3 Code, open **Settings → Integrations → Telegram** and paste the token. The token is kept in the environment's secret store.
4. Press **Link chat**. Telegram opens your bot; press **Start**. The bot replies once the chat is linked.

The bot belongs to one environment: link it in the environment whose agents should use it. A bot token works with one T3 Code server at a time.

## Send a dispatch

Ask an agent in plain words, for example "when you're done, send me a summary and a voice note on Telegram". You can also ask once for the whole conversation. The summary arrives first, then the report (split into numbered parts when it is long), then the voice note. Voice notes use the speech provider from **Settings → Extras → Voice**; they play as voice messages when `ffmpeg` is installed on the server or the provider returns MP3, and arrive as an audio file otherwise.

## Reply from Telegram

- **Text or voice note inside a topic** queues a message in that thread, as if you had typed it in T3 Code. A 👀 reaction confirms it arrived. Voice notes are transcribed first and the bot shows what it heard; this needs speech-to-text (`ELEVENLABS_API_KEY`) on the server.
- **✅ Done** under a summary settles the thread. The button then changes to **↩️ Reopen**, which brings the thread back.

Messages outside a topic only get a short help reply, and the bot ignores anyone but you. Replies you send while the server is off are picked up when it comes back, for up to a day.
