# Sending while the agent is working

You never have to wait for a turn to finish before typing. A message sent into a running thread
either steers or waits for later, and each route looks different at a glance.

## Steering

By default, sending during a running turn **steers**: the message goes to the agent so it can pick
it up part-way through its current work.

It rests above the composer for a few seconds first, so you can fix a typo, edit it, or drop it
before it leaves. On web and desktop, send an empty composer again to skip that wait and go now. The
recall window is five seconds by default; change it in **Settings → Extras** on web and desktop, or
**Settings → General** on mobile, where it is set per device.

## Queueing for later

Choose **Queue for later** instead and the message waits above the composer until the turn
finishes. Anything that piled up while the thread was unreachable waits the same way. When the turn
ends the whole waiting queue goes in together, rather than one message per turn.

Waiting messages can be steered, edited, or deleted from that list at any time.

## Waiting to be picked up

Once a steer leaves the composer it joins the conversation as a normal message — but the agent does
not always read it straight away. Some agents only check for new input between steps, so a message
sent while a long search, subagent, or shell command is running can sit unread until that step
finishes. That can take minutes.

While that is the case the message is shown dimmed, with **Waiting for the agent to pick this up**
underneath it. The note clears when the client sees the main agent move on, and also if the turn
finishes, is interrupted, or fails. Silence from the agent is expected while the note is showing;
you have not been ignored.

The note is a live view from the device you sent on. It is not part of the conversation, so it does
not appear on your other devices and it does not come back after a reload — the message itself is
unaffected either way.
