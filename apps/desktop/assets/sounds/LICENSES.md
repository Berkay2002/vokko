# Sounds

There are no audio files in this folder. Every notification sound is synthesised at runtime with Web Audio
(`src/notify/sounds.ts`: sine / triangle oscillators with a short envelope), so there is nothing to license and
nothing from Discord is used.

| Sound | Where | Synthesis |
| --- | --- | --- |
| `message` | new message that matches the notification setting | E5 then A5, sine, ~0.25 s |
| `mention` | @mention, reply ping, DM | G5, B5, E6 (triangle tail), ~0.45 s |
| `voice-join` | reserved for voice | 440 → 740 Hz glide, 0.18 s |
| `voice-leave` | reserved for voice | 740 → 392 Hz glide, 0.18 s |

If a recorded sound is ever added, drop the file here and list its source and licence in this table (CC0 only).
