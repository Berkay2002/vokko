# Parity roadmap

Target: Discord's feature behavior and familiar layout. A specific dated Discord reference has not yet been captured; no parity percentage is claimed.

Measure visible feature coverage separately from correct behavior and practical readiness. A wired button or a matching screen is not a completed feature.

| Area | Current status | Acceptance needed |
| --- | --- | --- |
| Desktop foundation | Implemented scaffold | Launch and operate on Windows/macOS/Linux; packaging and platform validation remain |
| Layout | Initial familiar four-column shell | Compare against a dated reference at multiple sizes; accessibility and keyboard audit |
| Communities/channels | Sample data and local navigation | Real membership, creation, permissions, and persistence |
| Text messages | Temporary desktop-local sending | Durable delivery, edits/deletes, pagination, reconnect, and permissions |
| Message formatting/attachments | Missing | Safe formatting, selection, uploads, previews, and accessible interactions |
| Accounts/roles/moderation | Missing | Authenticated server behavior and permission matrix |
| Voice/video/screenshare | Missing; voice area labelled unavailable | Capture, devices, processing, codecs, connectivity, platform permissions, and quality |
| Browser client | Read-only scaffold preview | Real browser transport and feature coverage |
| Mobile | Missing | Platform-specific architecture and usability assessment |
| Bots/notifications/search | Missing | Defined API contracts and end-to-end behavior |
| Self-hosting | Missing | Server/media source, migrations, deployment instructions, and independent operation |

First milestone: a working local hybrid shell with shared headless commands. Next: persistent messaging and a real server connection, with an early media investigation to reveal platform limitations. Keep layout work and behavioral acceptance tracked separately throughout.
