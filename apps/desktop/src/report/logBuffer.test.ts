import { afterEach, describe, expect, it } from "vitest";
import { clearLogs, recentLogs, recordLog, scrub } from "./logBuffer";

const SESSION = "3f9a1c0e7b2d4a6f8e1c3b5d7f9a0c2e4b6d8f1a3c5e7b9d0f2a4c6e8b1d3f5a"; // server tokens are 64 hex chars
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzYW0iLCJ2aWRlbyI6e319.c2lnbmF0dXJlLXBhcnQtaGVyZQ";

describe("scrub", () => {
  afterEach(clearLogs);

  const secrets: [string, string][] = [
    ["raw Authorization header", `Authorization: ${SESSION}`],
    ["Bearer header", `authorization: Bearer abc.def-ghi`],
    ["Bot header", `Authorization: Bot mybottoken123`],
    ["JSON token field", `{"token":"short1"}`],
    ["JSON password field", `{"password":"hunter2"}`],
    ["query token", `wss://live.example/rtc?access_token=xyz987&auto_subscribe=1`],
    ["signed URL", `https://cdn.example/a.png?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA/2026`],
    ["vokko signature", `/api/v1/embed-media?url=x&sig=abc123`],
    ["OAuth callback", `/oauth/callback?code=4/0AbcD&state=s1`],
    ["LiveKit JWT", `join ${JWT}`],
    ["bare session token", `retrying with ${SESSION}`],
    ["upload key", `key=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA`],
    ["cookie", `cookie: vokko_session=abcdef`],
    ["secret", `client_secret="s3cr3t"`],
  ];
  it.each(secrets)("removes a %s", (_, line) => {
    const out = scrub(line);
    expect(out).toContain("[redacted]");
    for (const secret of [SESSION, JWT, "abc.def-ghi", "mybottoken123", "short1", "hunter2", "xyz987", "deadbeef", "AKIA", "abc123", "0AbcD", "Zm9vYmFy", "abcdef", "s3cr3t"]) {
      expect(out).not.toContain(secret);
    }
  });

  it("keeps ordinary diagnostics readable", () => {
    expect(scrub("[vokko:voice] status reconnecting")).toBe("[vokko:voice] status reconnecting");
    expect(scrub("GET /api/v1/channels/1234567890123456789/messages 404 10003")).toBe("GET /api/v1/channels/1234567890123456789/messages 404 10003");
  });

  it("never stores a token or message content, and keeps only the last 500 lines", () => {
    recordLog("warn", ["send failed", { content: "my private message", headers: { Authorization: SESSION } }]);
    recordLog("voice", ["connected", { url: `wss://live.example/rtc?access_token=${JWT}` }]);
    const logs = recentLogs();
    expect(logs).not.toContain(SESSION);
    expect(logs).not.toContain(JWT);
    expect(logs).not.toContain("my private message");
    expect(logs).toContain("send failed");
    for (let i = 0; i < 600; i++) recordLog("warn", [`line ${i}`]);
    const lines = recentLogs().split("\n");
    expect(lines).toHaveLength(500);
    expect(lines[499]).toContain("line 599");
  });

  it("cuts a very long line after scrubbing, so a token cannot be split past the rule", () => {
    recordLog("error", ["x".repeat(995) + " " + SESSION]);
    expect(recentLogs()).not.toContain(SESSION.slice(0, 8));
  });
});
