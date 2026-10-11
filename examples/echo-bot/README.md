# Echo bot

A tiny Vokko bot that uses only the public API (`docs/api.md`, "Apps"): it registers `/echo text:` (answered ephemerally, only the
caller sees it) and `/roll sides:`, connects to the gateway with `Authorization`-style `Bot <token>` identify, and answers each
`INTERACTION_CREATE` with `POST /interactions/{id}/{token}/callback`. No dependencies (Node 22.18+: built-in `fetch`, `WebSocket`
and TypeScript type stripping).

1. In Vokko: User Settings > Developer > New Application. Copy the token (shown once) and the invite URL.
2. Open the invite URL and add the bot to a server you manage.
3. Run it:

```sh
VOKKO_API=http://127.0.0.1:8710 VOKKO_BOT_TOKEN=<token> VOKKO_GUILD_ID=<server id, optional> node bot.ts
```

`node --test bot.test.ts` checks the answers. The mock backend of the desktop client has the same bot built in
(`src/api/mock/apps.ts`, `__vokkoMock.installEchoBot()`), which the Playwright tests use.
