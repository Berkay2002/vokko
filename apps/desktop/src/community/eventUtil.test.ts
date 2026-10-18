import { describe, expect, it } from "vitest";
import { RecurrenceFrequency, ScheduledEventEntityType } from "../api/types";
import { describeRecurrence, formatEventRange, formatEventStart, fromInputs, hasErrors, repeatToRule, ruleToRepeat, toDateInput, toTimeInput, validateEventForm, weekdayOf, type EventForm } from "./eventUtil";

const NOW = new Date(2026, 9, 11, 15, 30); // Sunday 11 Oct 2026, local time

const form = (patch: Partial<EventForm> = {}): EventForm => ({
  name: "Movie night",
  description: "",
  entityType: ScheduledEventEntityType.External,
  channelId: "",
  location: "The lounge",
  startDate: "2026-10-12",
  startTime: "18:00",
  endDate: "2026-10-12",
  endTime: "20:00",
  repeat: "none",
  ...patch,
});

describe("event time text", () => {
  it("says today, tomorrow or the weekday and date", () => {
    expect(formatEventStart(new Date(2026, 9, 11, 18, 0).toISOString(), NOW, "en-US")).toBe("Today at 6:00 PM");
    expect(formatEventStart(new Date(2026, 9, 12, 9, 5).toISOString(), NOW, "en-US")).toBe("Tomorrow at 9:05 AM");
    expect(formatEventStart(new Date(2026, 9, 20, 18, 0).toISOString(), NOW, "en-US")).toBe("Tue, Oct 20 at 6:00 PM");
    expect(formatEventStart(new Date(2027, 0, 5, 18, 0).toISOString(), NOW, "en-US")).toContain("2027");
    expect(formatEventStart("nonsense", NOW)).toBe("");
  });

  it("appends the end time, or the end date when it ends another day", () => {
    const start = new Date(2026, 9, 11, 18, 0).toISOString();
    expect(formatEventRange({ scheduled_start_time: start, scheduled_end_time: new Date(2026, 9, 11, 20, 0).toISOString() }, NOW, "en-US")).toBe("Today at 6:00 PM – 8:00 PM");
    expect(formatEventRange({ scheduled_start_time: start, scheduled_end_time: new Date(2026, 9, 12, 1, 0).toISOString() }, NOW, "en-US")).toBe("Today at 6:00 PM – Tomorrow at 1:00 AM");
    expect(formatEventRange({ scheduled_start_time: start, scheduled_end_time: null }, NOW, "en-US")).toBe("Today at 6:00 PM");
  });
});

describe("recurrence", () => {
  it("round trips the wizard choices", () => {
    const start = new Date(2026, 9, 20, 18, 0); // a Tuesday
    expect(weekdayOf(start)).toBe(1);
    expect(repeatToRule("none", start)).toBeNull();
    const weekly = repeatToRule("weekly", start);
    expect(weekly).toMatchObject({ frequency: RecurrenceFrequency.Weekly, interval: 1, by_weekday: [1], end: null, count: null });
    for (const choice of ["daily", "weekly", "monthly", "yearly"] as const) expect(ruleToRepeat(repeatToRule(choice, start))).toBe(choice);
    expect(ruleToRepeat(null)).toBe("none");
    expect(ruleToRepeat({ ...weekly!, interval: 2 })).toBeNull();
    expect(ruleToRepeat({ ...weekly!, by_weekday: [1, 4] })).toBeNull();
  });

  it("describes a rule in words", () => {
    const base = { start: "2026-10-20T18:00:00.000Z", end: null, frequency: RecurrenceFrequency.Weekly, interval: 1, by_weekday: [1, 4], count: null };
    expect(describeRecurrence(base)).toBe("Repeats weekly on Tuesday, Friday");
    expect(describeRecurrence({ ...base, frequency: RecurrenceFrequency.Daily, interval: 2, by_weekday: null, count: 10 })).toBe("Repeats every 2 days, 10 times");
    expect(describeRecurrence({ ...base, frequency: RecurrenceFrequency.Monthly, by_weekday: null, end: "2027-01-01T00:00:00.000Z" }, "en-US")).toMatch(/^Repeats monthly until /);
    expect(describeRecurrence(null)).toBeNull();
  });
});

describe("date inputs", () => {
  it("converts between Date and the input strings", () => {
    const date = new Date(2026, 0, 5, 7, 4);
    expect([toDateInput(date), toTimeInput(date)]).toEqual(["2026-01-05", "07:04"]);
    expect(fromInputs("2026-01-05", "07:04")?.getTime()).toBe(date.getTime());
    expect(fromInputs("", "07:04")).toBeNull();
    expect(fromInputs("2026-01-05", "")).toBeNull();
  });
});

describe("validateEventForm", () => {
  it("accepts a good form", () => {
    expect(hasErrors(validateEventForm(form(), NOW))).toBe(false);
  });

  it("explains each problem", () => {
    expect(validateEventForm(form({ name: "  " }), NOW).name).toBeDefined();
    expect(validateEventForm(form({ name: "x".repeat(101) }), NOW).name).toBeDefined();
    expect(validateEventForm(form({ description: "x".repeat(1001) }), NOW).description).toBeDefined();
    expect(validateEventForm(form({ location: "" }), NOW).location).toBeDefined();
    expect(validateEventForm(form({ entityType: ScheduledEventEntityType.Voice, channelId: "" }), NOW).channelId).toBeDefined();
    // an event whose channel was deleted can be edited as it is
    expect(validateEventForm(form({ entityType: ScheduledEventEntityType.Voice, channelId: "", endDate: "", endTime: "" }), NOW, true, true).channelId).toBeUndefined();
    expect(hasErrors(validateEventForm(form({ entityType: ScheduledEventEntityType.Voice, channelId: "5", endDate: "", endTime: "" }), NOW))).toBe(false);
    expect(validateEventForm(form({ startDate: "2026-10-11", startTime: "15:00", endDate: "2026-10-11", endTime: "16:00" }), NOW).start).toBeDefined();
    expect(validateEventForm(form({ startDate: "2026-10-11", startTime: "15:00", endDate: "2026-10-11", endTime: "16:00" }), NOW, true).start).toBeUndefined();
    expect(validateEventForm(form({ endTime: "17:00" }), NOW).end).toBeDefined();
    expect(validateEventForm(form({ endDate: "", endTime: "" }), NOW).end).toBeDefined();
    expect(validateEventForm(form({ endDate: "2026-10-12", endTime: "" }), NOW).end).toBeDefined();
    expect(validateEventForm(form({ startDate: "" }), NOW).start).toBeDefined();
  });
});

describe("event times follow the clock choice", () => {
  it("the 24-hour setting wins over the locale's habit", async () => {
    const { usePrefs } = await import("../ui/prefs");
    try {
      usePrefs.setState({ timeFormat: "24" });
      expect(formatEventStart(new Date(2026, 9, 11, 18, 0).toISOString(), NOW, "en-US")).toBe("Today at 18:00");
      usePrefs.setState({ timeFormat: "12" });
      expect(formatEventStart(new Date(2026, 9, 11, 18, 0).toISOString(), NOW, "sv-SE")).toMatch(/6:00\s?(PM|em)/i);
    } finally {
      usePrefs.setState({ timeFormat: "auto" });
    }
  });
});
