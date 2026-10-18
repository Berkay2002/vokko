import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ButtonStyle, ComponentType, type Message, type MessageComponent } from "../api/types";
import type { ComponentClick } from "../apps/store";
import { ComponentRows } from "./MessageComponents";

const row = (...components: MessageComponent[]): MessageComponent => ({ type: ComponentType.ActionRow, components });
const button = (over: Partial<MessageComponent>): MessageComponent => ({ type: ComponentType.Button, style: ButtonStyle.Secondary, label: "Go", custom_id: "go", ...over });
const message = (components: MessageComponent[]): Message => ({ id: "7", channel_id: "3", application_id: "9", components }) as Message;
const html = (components: MessageComponent[], click?: ComponentClick): string => renderToStaticMarkup(<ComponentRows message={message(components)} click={click} />);

describe("MessageComponents", () => {
  it("renders nothing for a message without components", () => {
    expect(html([])).toBe("");
    expect(renderToStaticMarkup(<ComponentRows message={{ id: "7" } as Message} click={undefined} />)).toBe("");
  });

  it("renders buttons by style, and a link button as an https link that opens a new tab", () => {
    const out = html([row(button({ style: ButtonStyle.Success, label: "Confirm" }), button({ style: ButtonStyle.Danger, label: "Cancel", custom_id: "cancel" }), button({ style: ButtonStyle.Link, label: "Docs", custom_id: undefined, url: "https://example.com/d" }))]);
    expect(out).toContain("btn-success");
    expect(out).toContain("btn-danger");
    expect(out).toContain('href="https://example.com/d"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).not.toContain("disabled");
  });

  it("disables a disabled button, and a disabled link button loses its href", () => {
    const out = html([row(button({ disabled: true }), button({ style: ButtonStyle.Link, label: "Docs", custom_id: undefined, url: "https://example.com/d", disabled: true }))]);
    expect(out).toContain("disabled");
    expect(out).toContain('aria-disabled="true"');
    expect(out).not.toContain("href=");
  });

  it("disables every component of the message while a click is pending, then says when it failed", () => {
    const components = [row(button({}), button({ label: "Other", custom_id: "other" }))];
    const pending = html(components, { nonce: "n", state: "waiting" });
    expect(pending.match(/ disabled=""/g)).toHaveLength(2);
    expect(pending).toContain("Waiting for the app");
    const failed = html(components, { nonce: "n", state: "failed" });
    expect(failed).not.toContain("disabled");
    expect(failed).toContain("This interaction failed");
  });

  it("renders a select as a combobox showing its placeholder", () => {
    const out = html([row({ type: ComponentType.StringSelect, custom_id: "flavor", placeholder: "Pick a flavor", options: [{ label: "Vanilla", value: "v" }] })]);
    expect(out).toContain('role="combobox"');
    expect(out).toContain("Pick a flavor");
  });

  it("shows the default option of a select instead of the placeholder", () => {
    const out = html([row({ type: ComponentType.StringSelect, custom_id: "flavor", placeholder: "Pick a flavor", options: [{ label: "Vanilla", value: "v" }, { label: "Mint", value: "m", default: true }] })]);
    expect(out).toContain(">Mint</span>");
    expect(out).not.toContain(">Pick a flavor</span>");
  });
});
