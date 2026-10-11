import { SoundboardPanel } from "../soundboard/SoundboardPanel";
import { Popout } from "../ui";

/** Soundboard popout (anchored above the voice panel / control bar); the content lives in src/soundboard. */
export function SoundboardPopout({ anchor, open, onClose }: { anchor: HTMLElement | null; open: boolean; onClose: () => void }) {
  return (
    <Popout anchor={anchor} open={open} onClose={onClose} side="top" align="start" gap={8} className="voice-soundboard">
      <SoundboardPanel />
    </Popout>
  );
}
