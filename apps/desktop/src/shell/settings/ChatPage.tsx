import { setPref, usePhone, usePrefs } from "../../ui";
import type { SpoilerContent } from "../../ui/prefs";
import { Category, Page, RadioGroup, SwitchRow } from "./controls";

/** Settings > Chat (Discord's "Chat" page under App Settings). Every switch is a synced pref read by src/chat. */
export function ChatPage() {
  const p = usePrefs();
  const phone = usePhone(); // a phone always opens a thread in place of its channel
  return (
    <Page title="Chat">
      <Category title="Display Images, Videos and Lolcats">
        <SwitchRow label="When uploaded directly to Vokko" note="Off shows uploads as file cards you can open." checked={p.inlineAttachmentMedia} onChange={v => setPref("inlineAttachmentMedia", v)} />
        <SwitchRow label="When posted as links to the web" note="Off keeps link previews to their text." checked={p.inlineEmbedMedia} onChange={v => setPref("inlineEmbedMedia", v)} />
      </Category>
      <Category title="Embeds and Link Previews">
        <SwitchRow label="Show embeds and preview website links pasted into chat" checked={p.showEmbeds} onChange={v => setPref("showEmbeds", v)} />
      </Category>
      <Category title="Emoji">
        <SwitchRow label="Show emoji reactions on messages" checked={p.showReactions} onChange={v => setPref("showReactions", v)} />
        <SwitchRow label="Automatically convert emoticons in your messages to emoji" note="For example, when you type :) Vokko sends 🙂." checked={p.convertEmoticons} onChange={v => setPref("convertEmoticons", v)} />
        <SwitchRow label="Show emoji suggestions when you type :emoji:" checked={p.emojiAutocomplete} onChange={v => setPref("emojiAutocomplete", v)} />
      </Category>
      <Category title="Stickers">
        <SwitchRow label="Sticker suggestions" note="Suggest stickers when a word you type matches a sticker." checked={p.stickerSuggestions} onChange={v => setPref("stickerSuggestions", v)} />
        <SwitchRow label="Include stickers in autocomplete" note="Stickers show up next to emoji when you type :name." checked={p.stickerAutocomplete} onChange={v => setPref("stickerAutocomplete", v)} />
      </Category>
      <Category title="Text Box">
        <SwitchRow label="Preview emoji, mentions and markdown syntax as you type" checked={p.previewMarkdown} onChange={v => setPref("previewMarkdown", v)} />
      </Category>
      <Category title="Show Spoiler Content">
        <RadioGroup<SpoilerContent>
          name="Show spoiler content"
          value={p.spoilerContent}
          onChange={v => setPref("spoilerContent", v)}
          options={[
            { value: "click", label: "On click", note: "Spoilers stay hidden until you click them." },
            { value: "moderated", label: "On servers I moderate", note: "Shown where you can manage messages." },
            { value: "always", label: "Always" },
          ]}
        />
      </Category>
      {!phone && <Category title="Threads">
        <SwitchRow label="Open threads in split view" note="Off opens a thread in place of its channel." checked={p.threadSplitView} onChange={v => setPref("threadSplitView", v)} />
      </Category>}
    </Page>
  );
}
