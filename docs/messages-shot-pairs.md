# messages: my shot <-> reference shot

Mine: `artifacts/messages/` (outside the repo, 1489x1097 css at 1.25, Onyx, sv-SE; regenerate with `VOKKO_SHOTS_DIR=<dir> npx playwright test -c e2e/messages.config.ts messages.shots.spec.ts`).
Reference root: `.claude/reference/discord-2026-10-11/` (`ms` = `messages-states/`, `mu` = `messages-user/`).

| mine | reference |
|---|---|
| 01-channel-bottom, 02-channel-top | mu/channel-replies-image-mention.png |
| 03-hover-toolbar | ms/spec.md section 5 (toolbar measurements) |
| 04-context-menu-others | ms/09-menu-item-hover.png |
| 05-tag-popout | ms/spec.md section 3 (tag popout) |
| 06-lightbox | ms/12-lightbox-tall.jpg |
| 07-image-grid | ms/13-grid3-and-single.jpg |
| 08-lightbox-multi | ms/14-lightbox-grid-loading.jpg, ms/22-lightbox-grid2.jpg |
| 09-jump-pill | ms/36-jump-to-present-bar.png, ms/37-jump-to-present-bar-button-hover.png |
| 10-unread-banner-divider | ms/18-user-dm-unread-divider-banner.png, ms/19-user-dm-unread-after-revisit.png, mu/dm-unread-divider-banner.png, mu/dm-unread-after-revisit.png |
| 11-context-menu-at-pointer | ms/10-context-menu-own.jpg, mu/message-context-menu-own.png |
| 12-tray-two-images | ms/24-user-upload-tray-2.png, mu/upload-tray-2-images.png |
| 13-modify-attachment | ms/26-user-modify-attachment.png, mu/modify-attachment-modal.png |
| 14-pending-upload | ms/25-user-upload-in-progress.png, mu/upload-in-progress.png |
| 15-two-image-grid | ms/20-grid2-and-text.jpg, mu/two-image-grid-sent.png |
| 16-tray-four-images | mu/upload-tray-4-images.png |
| 17-four-image-grid-own-hover | ms/23-grid4-attachment-only.jpg, ms/21-grid2-hover-actions.png, mu/four-image-grid-grouped.png, mu/sent-image-hover-edit-delete.png |
| 18-delete-attachment-confirm | ms/27-user-delete-attachment-confirm.png, mu/delete-attachment-confirm.png |
| 19-emoticon-typing, 22-jumbo-emoji | ms/28-jumbo-emoji-after-grid4.jpg |
| 20-emoji-tooltip | ms/29-jumbo-emoji-tooltip.png |
| 21-emoji-popout | ms/30-jumbo-emoji-popout-frame.jpg, ms/31-jumbo-emoji-popout-zoom.png |
| 23-replying-to-image | ms/34-user-replying-state-composer.png, mu/reply-composer-to-image-message.png |
| 24-reply-to-image-sent | ms/32-reply-to-attachment-only.jpg, ms/35-user-reply-to-image-only-sent.png, mu/reply-to-image-only-sent.png |
