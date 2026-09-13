import completionUrl from "./assets/notification-completion.mp3";
import inputUrl from "./assets/notification-input.mp3";

export type NotificationSoundKind = "completion" | "input";

let audioContext: AudioContext | undefined;
const buffers = new Map<string, Promise<AudioBuffer>>();

/** Called from a gesture so browsers allow later background playback. */
export function unlockNotificationAudio() {
  if (typeof AudioContext === "undefined") return;
  audioContext ??= new AudioContext();
  void audioContext.resume().catch(() => undefined);
}

/**
 * Plays the sound for one announcement. Silently does nothing until a gesture
 * has unlocked audio; `shouldPlay` is re-checked after the (async) decode so a
 * setting switched off mid-flight stays quiet.
 */
export async function playNotificationSound(
  kind: NotificationSoundKind,
  shouldPlay: () => boolean,
) {
  if (!audioContext || audioContext.state !== "running") return;
  const context = audioContext;
  const url = kind === "completion" ? completionUrl : inputUrl;
  try {
    let buffer = buffers.get(url);
    if (!buffer) {
      buffer = fetch(url)
        .then((response) => response.arrayBuffer())
        .then((data) => context.decodeAudioData(data));
      buffers.set(url, buffer);
    }
    const decoded = await buffer;
    if (!shouldPlay() || context.state !== "running") return;
    const source = context.createBufferSource();
    source.buffer = decoded;
    source.connect(context.destination);
    source.start();
  } catch {
    buffers.delete(url);
  }
}
