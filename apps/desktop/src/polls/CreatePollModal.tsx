import { useRef, useState } from "react";
import { Plus, Smile, Trash2 } from "lucide-react";
import { POLL_ANSWER_MAX, POLL_DURATIONS_HOURS, POLL_MAX_ANSWERS, POLL_QUESTION_MAX, type Snowflake } from "../api/types";
import { ApiRequestError, Modal } from "../chat/shell";
import { EmojiPickerPopout } from "../chat/EmojiPicker";
import { Select, Toggle } from "../shell/settings/controls";
import { createPoll } from "./api";
import { DURATION_LABELS, draftToRequest, emptyDraft, type PollDraft } from "./pollState";
import "./polls.css";

const DURATION_OPTIONS = POLL_DURATIONS_HOURS.map(hours => ({ value: String(hours), label: DURATION_LABELS[hours] }));

function AnswerRow({ index, answer, canRemove, onChange, onRemove }: {
  index: number;
  answer: PollDraft["answers"][number];
  canRemove: boolean;
  onChange(next: PollDraft["answers"][number]): void;
  onRemove(): void;
}) {
  const emojiBtn = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  return (
    <div className="poll-create-answer">
      <button ref={emojiBtn} type="button" className="poll-create-emoji" aria-label={answer.emoji ? `Change emoji of answer ${index + 1}` : `Add emoji to answer ${index + 1}`}
        onClick={() => (answer.emoji ? onChange({ ...answer, emoji: null }) : setPicking(true))}>
        {answer.emoji ? answer.emoji.name : <Smile size={20} />}
      </button>
      <EmojiPickerPopout anchor={emojiBtn} open={picking} onClose={() => setPicking(false)} onPick={e => { setPicking(false); onChange({ ...answer, emoji: { id: e.id, name: e.name } }); }} />
      <input className="input" value={answer.text} maxLength={POLL_ANSWER_MAX} placeholder="Type your answer" aria-label={`Answer ${index + 1}`} onChange={e => onChange({ ...answer, text: e.target.value })} />
      {canRemove && (
        <button type="button" className="poll-create-remove" aria-label={`Remove answer ${index + 1}`} onClick={onRemove}>
          <Trash2 size={18} />
        </button>
      )}
    </div>
  );
}

/** Composer "+" → Create Poll: question, up to 10 answers with optional emoji, duration, multiple answers. */
export function CreatePollModal({ channelId, onClose }: { channelId: Snowflake; onClose(): void }) {
  const [draft, setDraft] = useState<PollDraft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checked = draftToRequest(draft);

  async function post() {
    if (busy) return;
    if ("error" in checked) {
      setError(checked.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createPoll(channelId, checked.request);
      onClose();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  }

  const setAnswer = (index: number, next: PollDraft["answers"][number]) => setDraft(d => ({ ...d, answers: d.answers.map((a, i) => (i === index ? next : a)) }));

  return (
    <Modal
      open
      onClose={onClose}
      title="Create a Poll"
      className="poll-create"
      footer={
        <>
          <label className="poll-create-multi">
            <Toggle checked={draft.multiselect} onChange={multiselect => setDraft(d => ({ ...d, multiselect }))} label="Allow Multiple Answers" />
            <span>Allow Multiple Answers</span>
          </label>
          <button type="button" className="btn btn-primary" disabled={busy || "error" in checked} onClick={() => void post()}>
            Post
          </button>
        </>
      }
    >
      <label className="field-label" htmlFor="poll-question">
        Question
      </label>
      <input id="poll-question" className="input" autoFocus value={draft.question} maxLength={POLL_QUESTION_MAX} placeholder="What question do you want to ask?"
        onChange={e => setDraft(d => ({ ...d, question: e.target.value }))} />
      <div className="field-label poll-create-label">Answers</div>
      {draft.answers.map((answer, index) => (
        <AnswerRow key={index} index={index} answer={answer} canRemove={draft.answers.length > 1} onChange={next => setAnswer(index, next)}
          onRemove={() => setDraft(d => ({ ...d, answers: d.answers.filter((_, i) => i !== index) }))} />
      ))}
      {draft.answers.length < POLL_MAX_ANSWERS && (
        <button type="button" className="poll-create-add" onClick={() => setDraft(d => ({ ...d, answers: [...d.answers, { text: "", emoji: null }] }))}>
          <Plus size={18} /> Add another answer
        </button>
      )}
      <div className="field-label poll-create-label">Duration</div>
      <Select<string> label="Duration" value={String(draft.duration)} options={DURATION_OPTIONS} onChange={value => setDraft(d => ({ ...d, duration: Number(value) }))} />
      {error && <p className="field-error">{error}</p>}
    </Modal>
  );
}
