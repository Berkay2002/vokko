import { describe, expect, it } from "vitest";
import { MessageType, type Message, type Poll } from "../api/types";
import { applyPollVote, draftToRequest, emptyDraft, isEnded, leaders, percentOf, resultSummary, timeLeft, totalVotes } from "./pollState";

const poll = (counts: [number, boolean][], extra: Partial<Poll> = {}): Poll => ({
  question: { text: "Q" },
  answers: counts.map((_, i) => ({ answer_id: i + 1, poll_media: { text: `A${i + 1}` } })),
  expiry: new Date(Date.now() + 3_600_000).toISOString(),
  allow_multiselect: false,
  layout_type: 1,
  results: { is_finalized: false, answer_counts: counts.map(([count, me], i) => ({ id: i + 1, count, me_voted: me })) },
  ...extra,
});
const message = (p: Poll): Message =>
  ({ id: "1", channel_id: "2", guild_id: null, content: "", type: MessageType.Default, mentions: [], attachments: [], embeds: [], reactions: [], poll: p }) as unknown as Message;
const counts = (m: Message) => m.poll!.results.answer_counts.map(c => [c.count, c.me_voted]);

describe("applyPollVote", () => {
  it("adds and removes votes from others and from me", () => {
    let m = message(poll([[0, false], [2, false]]));
    m = applyPollVote(m, 1, true, true);
    expect(counts(m)).toEqual([[1, true], [2, false]]);
    m = applyPollVote(m, 2, false, false);
    expect(counts(m)).toEqual([[1, true], [1, false]]);
    m = applyPollVote(m, 1, false, true);
    expect(counts(m)).toEqual([[0, false], [1, false]]);
  });

  it("ignores my echo for a state already shown, unknown answers and non-polls", () => {
    const m = message(poll([[1, true]]));
    expect(applyPollVote(m, 1, true, true)).toBe(m);
    expect(applyPollVote(m, 9, true, false)).toBe(m);
    const plain = { ...m, poll: undefined } as Message;
    expect(applyPollVote(plain, 1, true, false)).toBe(plain);
  });
});

describe("poll maths", () => {
  it("percentages, totals, leaders and the ended state", () => {
    const p = poll([[1, false], [2, false], [0, false]]);
    expect(totalVotes(p)).toBe(3);
    expect([percentOf(1, 3), percentOf(2, 3), percentOf(0, 0)]).toEqual([33, 67, 0]);
    expect(leaders(p)).toEqual([2]);
    expect(leaders(poll([[0, false]]))).toEqual([]);
    expect(isEnded(p, Date.now())).toBe(false);
    expect(isEnded(p, Date.now() + 2 * 3_600_000)).toBe(true);
    expect(isEnded({ ...p, results: { ...p.results, is_finalized: true } }, Date.now())).toBe(true);
  });

  it("formats the time left", () => {
    const now = Date.parse("2026-10-12T00:00:00Z");
    const at = (ms: number) => new Date(now + ms).toISOString();
    expect(timeLeft(at(30_000), now)).toBe("Less than a minute left");
    expect(timeLeft(at(12 * 60_000), now)).toBe("12m left");
    expect(timeLeft(at(5 * 3_600_000), now)).toBe("5h left");
    expect(timeLeft(at(3 * 86_400_000), now)).toBe("3d left");
    expect(timeLeft(at(-1), now)).toBe("Poll closed");
  });
});

describe("draftToRequest", () => {
  it("drops blank answers and keeps emoji, duration and multiselect", () => {
    const draft = { ...emptyDraft(), question: " Lunch? ", duration: 72, multiselect: true };
    draft.answers = [{ text: "Pizza", emoji: { id: null, name: "🍕" } }, { text: "  ", emoji: null }, { text: "Sushi", emoji: null }];
    expect(draftToRequest(draft)).toEqual({
      request: {
        question: { text: "Lunch?" },
        answers: [{ poll_media: { text: "Pizza", emoji: { id: null, name: "🍕" } } }, { poll_media: { text: "Sushi" } }],
        duration: 72,
        allow_multiselect: true,
      },
    });
  });

  it("explains what is missing", () => {
    expect(draftToRequest(emptyDraft())).toEqual({ error: "Add a question." });
    expect(draftToRequest({ ...emptyDraft(), question: "q" })).toEqual({ error: "Add at least one answer." });
    expect("error" in draftToRequest({ ...emptyDraft(), question: "q".repeat(301), answers: [{ text: "a", emoji: null }] })).toBe(true);
  });
});

describe("resultSummary", () => {
  it("reads the winner and the tie case from the poll_result embed", () => {
    const fields = (pairs: [string, string][]) => [{ type: "poll_result" as const, fields: pairs.map(([name, value]) => ({ name, value })) }];
    expect(resultSummary(fields([["poll_question_text", "Q"], ["total_votes", "3"], ["victor_answer_id", "2"], ["victor_answer_text", "Sushi"], ["victor_answer_votes", "2"], ["victor_answer_emoji_name", "🍣"]]))).toEqual({
      question: "Q",
      total: 3,
      winner: { id: 2, text: "Sushi", votes: 2, emoji: { id: null, name: "🍣" } },
    });
    expect(resultSummary(fields([["poll_question_text", "Q"], ["total_votes", "2"]]))?.winner).toBeNull();
    expect(resultSummary([])).toBeNull();
  });
});
