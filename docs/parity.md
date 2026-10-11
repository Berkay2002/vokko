# Parity roadmap

Target: Discord's feature behavior and familiar layout. A specific dated Discord reference has not yet been captured; no parity percentage is claimed.

Vokko is free: every Discord Nitro / paid perk is a normal feature for everyone (parity target = Discord with Nitro). Out of scope: the paid machinery itself: Nitro, billing, shop, boost and quest screens, badges, purchase flows and upsell prompts.

Measure visible feature coverage separately from correct behavior and practical readiness. A wired button or a matching screen is not a completed feature.

Rows come from [parity-inventory.md](parity-inventory.md) (ids and acceptance text; the reference captures are private). The out-of-scope and perks-without-ids sections of the inventory are not tracked here. The inventory's DESK section has no ids; its items are numbered DESK-01 to DESK-08 here in the order listed.

How to read the statuses: `-` not started, `partial` some of it exists, `done` implemented as described, `n/a` no status applies (out of scope, behaviour-only row, or no reference to compare). **looks the same** is visuals against the reference. It was judged from the code only (CSS, tokens, dimensions against the numbers in the acceptance text), not from screenshots, so it is `done` only where the code clearly implements the stated dimensions and states. **works the same** is behaviour against real server behaviour: `done` only where the UI in `apps/desktop/src` and the server in `crates/server/src` both exist and the behaviour is implemented (client-only preferences count as done when no server is involved; per-device settings that Discord keeps on the server are `partial`). The notes name the evidence or what is missing.

## Summary

Counts are rows by their **works the same** column. They are counts, not a parity percentage.

| area | rows | done | partial | not started | n/a |
| --- | ---: | ---: | ---: | ---: | ---: |
| SHELL | 15 | 5 | 10 | 0 | 0 |
| FRIEND | 7 | 4 | 2 | 1 | 0 |
| DM | 10 | 7 | 1 | 2 | 0 |
| MSG | 25 | 14 | 6 | 4 | 1 |
| CMP | 14 | 5 | 5 | 4 | 0 |
| GLD | 18 | 4 | 8 | 6 | 0 |
| POP | 6 | 2 | 4 | 0 | 0 |
| MOD | 11 | 4 | 6 | 1 | 0 |
| SET | 7 | 2 | 5 | 0 | 0 |
| REST | 6 | 0 | 2 | 4 | 0 |
| DESK | 8 | 0 | 1 | 7 | 0 |
| **Total** | **127** | **47** | **50** | **29** | **1** |

## SHELL: app shell, rail, DM sidebar, title bar

| id | feature | looks the same | works the same | notes |
| --- | --- | --- | --- | --- |
| SHELL-001 | 32 px title bar, centred title, inbox and help buttons right | partial | partial | TitleBar.tsx: 32 px, inbox and help right; centre shows the current page title, not the app name; Help button has no action |
| SHELL-002 | Server rail 72 px, 48 px pitch, 40 px squircle icons, selected icon morphs | partial | done | ServerRail.tsx, shell.css: 72/40/48 and squircle match; selected icon does not change shape; guilds from GET /users/@me/guilds |
| SHELL-003 | Rail pill indicator: selected, hover, unread, idle states | done | done | shell.css .rail-pill heights 40/20/8, hidden idle, 0.2 s ease-out; unread comes from server read states |
| SHELL-004 | Rail tooltip on hover, right of icon | partial | done | Tooltip side right on every rail item; tooltip styling differs from reference (see POP-003) |
| SHELL-005 | Rail separator, add-server, discover, download-apps buttons | partial | partial | Add-server opens the create-server flow (POST /guilds); discover is aria-disabled; no download-apps button |
| SHELL-006 | Rail scrolls independently; collapsible folders | partial | partial | Rail scrolls (overflow-y, hidden scrollbar); no folders |
| SHELL-007 | Home button and unread DM avatars with mention badge | partial | done | ServerRail.tsx DmRailItem and rail-badge, driven by server read states and mention_count; no reference capture to compare |
| SHELL-008 | DM sidebar 303 px list, top-left radius 12, find-or-start search button | done | partial | DmSidebar.tsx, shell.css .sidebar (303 px default, radius 12); button opens quick switcher, which only searches already loaded data (no server search) |
| SHELL-009 | Friends nav row h40 with active and hover states | partial | done | DmSidebar.tsx nav-row is 38 px high, not 40; pending badge from relationships |
| SHELL-010 | Direct Messages header with + button; DM rows with avatar, presence, name, subtitle | partial | partial | dm-row is 42 px high, not 44; create DM (POST /users/@me/channels), close DM (DELETE /channels/{id}), presence dot; 1:1 rows have no status subtitle |
| SHELL-011 | Group DM row member count subtitle; clan tag chips | partial | partial | DmSidebar.tsx shows member count; server tag chips (in API) are not rendered in DM rows |
| SHELL-012 | Floating user panel with avatar, status dot, name, status text, mute, deafen, settings | done | partial | UserPanel.tsx, shell.css (x=8, 359 wide, 57 high, radius 8); status via gateway op 3; mute and deafen are local toggles with no audio behind them |
| SHELL-013 | Mute and deafen split caret opens input and output device menus | partial | partial | UserPanel.tsx device menus list devices from enumerateDevices; choice only stored in local prefs, no audio engine |
| SHELL-014 | User-panel popout: profile card, edit profile, status submenu, switch account, copy ID | partial | partial | UserPanel.tsx popout has status list and custom status (persisted via gateway); no profile card, edit profile, switch account or copy ID rows |
| SHELL-015 | 4 px resize handle; layout at about 1000 px and minimum width | partial | partial | AppShell.tsx sidebar-resize (4 px, clamped, stored locally); no responsive layout rules (no media queries) |

## FRIEND: Friends page

| id | feature | looks the same | works the same | notes |
| --- | --- | --- | --- | --- |
| FRIEND-001 | Header h49 with Friends title, Online/All/Pending/Blocked tabs, Add Friend | partial | done | FriendsPage.tsx, header 49 px; tabs filter real relationships (GET /users/@me/relationships) |
| FRIEND-002 | Friend rows: avatar, name, status, hover actions | partial | partial | FriendsPage.tsx PersonRow; message action works; the More action has no handler |
| FRIEND-003 | Pending tab with empty state illustration and text | partial | done | Incoming/outgoing lists with accept, ignore, cancel via PUT/DELETE relationships; empty-state text only, no illustration |
| FRIEND-004 | Suggestions list | - | - | No suggestions tab or server route |
| FRIEND-005 | Add Friend form with username input and send button | partial | done | FriendsPage.tsx AddFriend: POST /users/@me/relationships by username, success and error messages |
| FRIEND-006 | Active Now column with activity cards | partial | partial | ActiveNow in FriendsPage.tsx: 420 px column; cards only show friends with a custom status (no activity data exists) |
| FRIEND-007 | Search bar in the friends list with filter | partial | done | FriendsPage.tsx people-search filters by display name or username (client side) |

## DM: DM channel frame

| id | feature | looks the same | works the same | notes |
| --- | --- | --- | --- | --- |
| DM-001 | Header h49: avatar, name, call, video, pins, add-to-DM, profile toggle, search box | partial | partial | ChannelHeader.tsx: buttons 32 px, search box 144/240 px wide, not 244; call and video disabled; add-to-DM creates a new group (no add-recipient route); search input is inert |
| DM-002 | Header icon tooltips below the button | partial | done | ChannelHeader.tsx ToolbarButton uses Tooltip side bottom; tooltip styling see POP-003 |
| DM-003 | Start-of-DM block: avatar, name, username, description, mutual servers, friend and block buttons | done | done | ChannelStart.tsx and chat.css (80 px avatar, 32/40 and 24/30 type); GET /users/{id}/profile, relationship PUT/DELETE incl. block |
| DM-004 | Day divider: centred label on a thin line | partial | done | MessageList.tsx and chat.css: line is 1 px, reference 0.67 px; dividers computed from message timestamps |
| DM-005 | Right profile aside 320 px with banner, avatar, member-since, view full profile | partial | done | DmProfilePanel.tsx, menus.css: width 320 and avatar 80 match, banner is 120 px not 105; GET /users/{id}/profile |
| DM-006 | Pinned messages popout with empty state and tip footer | partial | done | PinnedMessages.tsx: 420 px wide but max height 560 (not 371) and no tip footer; paginated GET pins, jump to message |
| DM-007 | In-DM search results panel | - | - | Header search input is inert; no search route in crates/server |
| DM-008 | Call UI: start voice or video call, incoming call screen | - | - | Call buttons are disabled; no voice state in the server contract |
| DM-009 | Typing indicator under the composer | partial | done | TypingIndicator.tsx plus POST /channels/{id}/typing and TYPING_START with Discord timings |
| DM-010 | New-messages divider, mark-as-read bar, jump-to-present bar | partial | done | MessageList.tsx unread bar, NEW divider, jump bar; ack and read states from server |

## MSG: message list and message actions

| id | feature | looks the same | works the same | notes |
| --- | --- | --- | --- | --- |
| MSG-001 | Cozy layout: avatar, name, timestamp, content, row padding | done | done | chat.css: 40 px avatar, 16/22 type, 12/22 timestamp, padding 2/24/2/72; GET/POST messages in crates/server/src/routes/messages.rs |
| MSG-002 | Message grouping: 17 px group margin, collapsed follow-ups, time on hover in gutter | partial | done | chat.css 17 px margin matches; hover-time gutter width not verified against 56 px; grouping in messageState.ts |
| MSG-003 | Row hover background | done | done | tokens.css --message-background-hover is rgba(151,151,159,0.12) |
| MSG-004 | Hover toolbar: quick reactions, add reaction, edit, reply, forward, more | partial | partial | MessageItem.tsx and chat.css (28 px buttons, radius 8, offset -16/14 match); no forward button |
| MSG-005 | Context menu: reactions, edit, reply, forward, thread, copy, pin, bookmark, remind, apps, mark unread, link, TTS, delete, ID | partial | partial | MessageItem.tsx items(): working reaction, edit, reply, copy, pin, link, delete, ID; forward, thread, mark unread disabled; no quick reaction row, bookmark, remind, apps, TTS |
| MSG-006 | Context-menu item hover and focus state; destructive item in danger colour | partial | done | ContextMenu.tsx, menus.css with danger items; exact colours not compared |
| MSG-007 | Reply flow: bar above composer, highlighted target row, Escape cancels | done | done | Composer.tsx reply bar, chat.css .replying (2 px brand bar, 16% tint); message_reference and allowed_mentions handled in routes/messages.rs |
| MSG-008 | Reply reference line above a reply: avatar, name, snippet, connector, jump | done | done | MessageItem.tsx ReplyPreview (16 px avatar, curved spine, click jumps); referenced_message from server, deleted-original state |
| MSG-009 | Inline edit: textarea in place, hint, emoji button | partial | done | MessageItem.tsx InlineEdit: PATCH message works; hint wording differs and there is no emoji button |
| MSG-010 | (edited) marker after edited content | done | done | chat.css .chat-edited is 10 px with line-height 1, muted; edited_timestamp from server |
| MSG-011 | Delete confirmation modal with message preview | partial | done | ChatView.tsx DeleteModal with preview; DELETE message; no reference to compare against |
| MSG-012 | Reactions: pills, own highlighted, + button on hover, reactor tooltip | partial | done | Reactions.tsx; PUT/DELETE/GET reactions in routes/reactions.rs; unicode emoji only (custom emoji do not render) |
| MSG-013 | Reaction picker from the hover bar with search | partial | done | EmojiPicker.tsx popout from the toolbar, search; unicode emoji set only |
| MSG-014 | Pin from the menu: confirm modal, then system row with pin icon | partial | partial | Pin applies immediately, no confirm modal; PUT pin emits a type 6 system row (MessageItem.tsx SystemBody); 250 cap handled |
| MSG-015 | Forward modal | - | - | Forward menu item is disabled |
| MSG-016 | Bookmark and reminder submenu | - | - | Not in the message menu; inbox bookmark and reminder tabs are empty placeholders |
| MSG-017 | Markdown rendering: emphasis, code, headings, lists, quotes, links, spoilers, timestamps, shortcodes | partial | done | chat/markdown/ (parse.ts, render.tsx, highlight.ts, unit tests) covers the listed syntax; styling not compared |
| MSG-018 | Link embeds: invite embed incl. expired state, URL previews, image and video embeds | partial | done | Embeds.tsx; invites via GET /invites/{code}; server unfurl.rs builds embeds, delivered by MESSAGE_UPDATE |
| MSG-019 | Attachments: image grid with lightbox, files, video and audio players, spoiler | partial | partial | Attachments.tsx: grid, lightbox, file cards, video, SPOILER_ files; routes/attachments.rs; audio files show as file cards (no player) |
| MSG-020 | Stickers and GIFs in messages | - | - | No sticker or GIF support in client or server |
| MSG-021 | Message selection and long-press mobile gestures | n/a | n/a | Out of scope (desktop web) |
| MSG-022 | Mention chips and mention-highlighted row with 2 px bar | partial | partial | markdown render.tsx chips (user, role, channel, everyone), chat.css .mentioned 2 px bar; row highlight only for user and everyone mentions (server has no mention_roles) |
| MSG-023 | Slash-command output and application messages: bot badge, ephemeral | partial | - | BOT tag renders in MessageItem.tsx; no commands, apps or ephemeral messages |
| MSG-024 | System messages with icon and muted style | partial | partial | MessageItem.tsx SystemBody handles pin, join, leave, rename; server posts pin and join rows; no call messages |
| MSG-025 | Message length limit 2000 with counter and block | partial | done | Composer.tsx counter and send block; server rejects over 2000 (routes/messages.rs) |

## CMP: composer

| id | feature | looks the same | works the same | notes |
| --- | --- | --- | --- | --- |
| CMP-001 | Composer wrapper height, radius, border, grows to about half the viewport | partial | done | Composer.tsx, chat.css: 56 px min height with 1 px border (reference 0.67), auto-grow up to 50vh |
| CMP-002 | Attach + button menu: upload file, create poll, use apps | partial | partial | Composer.tsx: only Upload a File (POST attachments); no poll, no apps |
| CMP-003 | Right buttons: GIF, sticker, emoji, apps | partial | partial | Composer.tsx: four buttons present; emoji works, GIF/sticker/apps open empty-state panels |
| CMP-004 | Emoji picker with tabs, search, category rail, 48 px cells, preview footer | done | partial | chat.css expression picker 498x486, 48 px cells, footer preview; unicode only, GIF and sticker tabs are empty |
| CMP-005 | GIF picker with search, categories, trending | partial | - | ExpressionPicker.tsx: search box with an honest empty state; no provider |
| CMP-006 | Sticker picker | partial | - | ExpressionPicker.tsx: empty state; no sticker packs |
| CMP-007 | @ autocomplete for members and roles with keyboard selection, Tab inserts chip | partial | done | Composer.tsx suggestions (members, mentionable roles, everyone/here); sends raw mention tokens; server parses them |
| CMP-008 | Emoji shortcode autocomplete with preview | partial | done | Composer.tsx ':' trigger lists matches from the emoji database; no preview pane |
| CMP-009 | Slash-command panel with app rail | - | - | No slash-command handling |
| CMP-010 | # channel autocomplete (guild only) | partial | done | Composer.tsx '#' trigger, text channels only in guilds |
| CMP-011 | Live markdown styling in the editor | - | - | Plain textarea; the previewMarkdown preference is not wired |
| CMP-012 | Shift+Enter newline, Enter send, Escape clears reply, Up edits last message | n/a | done | Composer.tsx onKeyDown and ChatView.tsx editLast; behaviour row, no visuals |
| CMP-013 | Paste and drag-drop upload preview with remove, spoiler, alt text | partial | partial | draftStore.ts, Composer.tsx tray, drop overlay in ChatView.tsx; remove works; no spoiler or alt-text controls |
| CMP-014 | Slowmode, locked channel, no-permission composer states | - | partial | Server rejects sends without SEND_MESSAGES; composer shows no locked state; no slowmode in crates/server |

## GLD: guild frame

| id | feature | looks the same | works the same | notes |
| --- | --- | --- | --- | --- |
| GLD-001 | Server header h49 with name, chevron flip, invite shortcut; banner variant | partial | partial | GuildSidebar.tsx GuildHeader: 49 px, chevron, invite button (POST invites); no banner variant |
| GLD-002 | Server dropdown: invite, settings, create, event, apps, notifications, privacy, profile, hide muted, ID | partial | partial | menus.tsx guildDropdownItems: invite, settings, channel/category, notifications, hide muted, leave, ID work; event, app directory, privacy, profile entries disabled; notification and hide-muted choices are local only |
| GLD-003 | Event quick link under the header | - | - | No events |
| GLD-004 | Category header with collapse chevron and + button | partial | done | GuildSidebar.tsx category-header; collapse stored locally; + creates a channel (POST /guilds/{id}/channels) |
| GLD-005 | Channel row 32 px, icon, name, selected state, hover actions | partial | done | shell.css .channel-row 32 px, radius 8; hover invite and edit-channel actions; no open-chat action |
| GLD-006 | Channel states: unread, mention badge, muted, locked icon | partial | partial | GuildSidebar.tsx: unread and mention badge from server read states, lock icon from overwrites; mute is stored locally only |
| GLD-007 | Voice channel with connected users listed; join on click | partial | - | api/voice.ts is a client-only store (mock seeded); click does nothing; no voice in crates/server |
| GLD-008 | Channel header with name, topic, toolbar (threads, notifications, pins, members), search | partial | partial | ChannelHeader.tsx: name, topic, pins, member toggle work; threads disabled; notification menu is local; search 144/240 px and inert |
| GLD-009 | Start-of-channel header: tile, welcome text, edit-channel button | partial | partial | ChannelStart.tsx: 68 px tile and welcome text; no edit-channel button |
| GLD-010 | New-server welcome checklist | - | - | Not built |
| GLD-011 | Member list: role groups, online/offline, presence dots, activity line, role colours | done | done | MemberList.tsx, tokens.css (264 px, rows 248x42); GET /guilds/{id}/members, presence via gateway |
| GLD-012 | Channel, category and server-icon right-click menus | partial | partial | menus.tsx channelContextItems and guildContextItems work (edit, duplicate, delete, invite, ID); privacy and profile entries disabled; mute is local |
| GLD-013 | Threads: list popout, side panel, starter message | - | - | Threads button disabled; no thread routes |
| GLD-014 | Forum channel: post list, tags, create-post flow | - | - | Forum option disabled in the create-channel modal |
| GLD-015 | Announcement channel and stage channel | - | - | Only text, voice and category channel types |
| GLD-016 | Server folder and server context menu in the rail | partial | partial | Rail context menu exists (menus.tsx guildContextItems); no folders |
| GLD-017 | Member-list profile popout on click | partial | done | ProfileCard.tsx opens from the member list; roles, member-since, message and add-friend actions |
| GLD-018 | Invite modal: link, copy, expiry settings, friends list | partial | partial | Modals.tsx InviteModal creates and copies a link (POST /channels/{id}/invites, fixed 24 h); no expiry settings, no friends list although the server accepts max_age and max_uses |

## POP: popouts and menus

| id | feature | looks the same | works the same | notes |
| --- | --- | --- | --- | --- |
| POP-001 | User profile popout: banner, avatar, status, name, badges, roles, primary button | partial | done | ProfileCard.tsx, shell.css (300 px wide, 60 px banner); roles, bio, status, message button; badges out of scope |
| POP-002 | Full profile modal with activity, mutual servers and mutual friends tabs | partial | partial | DmProfilePanel.tsx FullProfileModal: About and Mutual Servers work; mutual friends shows a count only; no activity tab |
| POP-003 | Tooltips: dark pill, 14/18 w500, arrow | partial | done | ui.css .tooltip has arrow but is 16/20 w600 on the surface colour |
| POP-004 | Notification-settings popout and mute submenu | partial | partial | menus.tsx muteItem and Modals.tsx NotificationSettingsModal work but are saved on this device only (localState.ts), not on the server |
| POP-005 | Inbox popout with unread, mentions, bookmarks, reminders tabs | partial | partial | Inbox.tsx: 480 px wide; Unreads and Mentions derived from server read states; bookmarks, reminders, scheduled are placeholders |
| POP-006 | Emoji, GIF and sticker pickers as popouts | partial | partial | See CMP-004 to CMP-006 |

## MOD: modals

| id | feature | looks the same | works the same | notes |
| --- | --- | --- | --- | --- |
| MOD-001 | Create-server step 1: templates and join with invite | partial | done | Modals.tsx CreateServer: template list and Join a Server (POST /invites/{code}); modal size not checked against 443x560 |
| MOD-002 | Create-server step 2: purpose question with skip | partial | done | Modals.tsx purpose step with skip link |
| MOD-003 | Create-server step 3: icon uploader, name input, guidelines link, Back and Create | partial | done | Modals.tsx customize step (POST /guilds, icon via attachment upload); no guidelines link |
| MOD-004 | Create-channel modal: type radios, name with prefix, private switch, buttons | partial | done | Modals.tsx CreateChannelModal; private creates an @everyone VIEW_CHANNEL deny overwrite; forum radio disabled |
| MOD-005 | Quick switcher: input, recent channels, tips footer | partial | partial | QuickSwitcher.tsx: prefixes and PROTIP footer; searches loaded data only, no recents list |
| MOD-006 | Keyboard shortcuts dialog with key-cap cards | partial | partial | Ctrl+/ opens the Keybinds settings page (KeybindsPage.tsx), a table rather than a dialog; some listed shortcuts are not wired |
| MOD-007 | Confirmation modals: delete message, leave server, unsaved-changes bar | partial | partial | Delete message and leave server confirms work; the unsaved bar exists in channel settings only (see SET-007) |
| MOD-008 | Image lightbox with zoom, open original, download | partial | partial | Attachments.tsx Lightbox: previous/next, Open in Browser; no zoom, no download button |
| MOD-009 | Report, block and remove-friend confirmations | partial | partial | Block confirm in ChannelStart.tsx; context-menu block and remove-friend act without confirmation; no report |
| MOD-010 | Join-server-with-invite modal and invite landing screen | partial | partial | Join modal works; no invite landing route |
| MOD-011 | Pin confirmation modal with preview and buttons | - | - | Pin is applied immediately (see MSG-014) |

## SET: settings

| id | feature | looks the same | works the same | notes |
| --- | --- | --- | --- | --- |
| SET-001 | User settings as large modal with left nav, search, title strip, close and Esc | partial | done | UserSettings.tsx: full-screen overlay with 218 px nav, section search, ESC close button (reference 253 px nav in a centred modal) |
| SET-002 | My Account page: info rows with Change buttons, password and security rows | partial | partial | UserSettings.tsx MyAccount: display name saves via PATCH /users/@me; no email, password or security rows |
| SET-003 | Appearance page: theme toggle and default theme swatches | partial | done | AppearancePage.tsx theme cards, sync with system, message display; stored as local preferences |
| SET-004 | Accessibility, Voice and Video, Chat, Notifications, Keybinds, Language, Streamer mode, Advanced | partial | partial | Pages exist for Accessibility, Voice and Video, Notifications, Keybinds (read-only), Language (English only), streamer toggles; all local prefs, no audio engine, nothing fires; Chat and Advanced missing |
| SET-005 | Server settings: overview, roles, emoji, stickers, soundboard, integrations, moderation, audit log, bans, invites, onboarding, community | partial | partial | ServerSettings.tsx: Profile (PATCH /guilds/{id}), Roles, Members, Bans, Tag, Theme work; Invites only creates; emoji, stickers, soundboard, integrations, audit log, safety, onboarding, community are placeholders |
| SET-006 | Channel settings: overview, permissions, invites, integrations | partial | partial | ChannelSettings.tsx: Overview (PATCH /channels/{id}) and Permissions (overwrite routes) work; Invites and Integrations are placeholders; no slowmode |
| SET-007 | Unsaved-changes bar with shake animation, reset and save | partial | partial | settings/SaveBar.tsx used by channel settings; no shake; not used on other pages |

## REST: remaining

| id | feature | looks the same | works the same | notes |
| --- | --- | --- | --- | --- |
| REST-001 | Server-wide message search with filters and results panel | - | - | No search route in crates/server; header search inputs are inert |
| REST-002 | Login, register, password reset, MFA screens | partial | partial | AuthPages.tsx login and register (POST /auth/login, /auth/register); no password reset or MFA |
| REST-003 | Onboarding flow for new members | - | - | Not built; settings page is a placeholder |
| REST-004 | Loading screen, connection-lost banner, update and maintenance banners | partial | partial | App.tsx Splash loading dots; store tracks gateway status but no banner is shown; no update banners |
| REST-005 | Notification sounds and desktop notifications | - | - | Preference toggles only (NotificationsPage.tsx); no Notification or audio calls anywhere |
| REST-006 | Responsive layouts at about 1000 px and minimum width | - | - | No media queries in apps/desktop/src/styles; Tauri window has a minimum size only |

## DESK: desktop-only

| id | feature | looks the same | works the same | notes |
| --- | --- | --- | --- | --- |
| DESK-01 | Voice and video call overlay | n/a | - | No voice or video (see DM-008); no overlay window |
| DESK-02 | Game overlay | n/a | - | Not started |
| DESK-03 | Tray icon and close-to-tray | n/a | - | src-tauri/src/main.rs has no tray code |
| DESK-04 | Push-to-talk global keybinds | n/a | - | Keybinds are in-page only; no global shortcuts |
| DESK-05 | Rich presence and game detection | n/a | - | Presence has status and custom status only |
| DESK-06 | Run on startup | n/a | - | No autostart plugin |
| DESK-07 | Native window controls | n/a | partial | Tauri window uses native decorations (tauri.conf.json); the web title bar also renders in the desktop build |
| DESK-08 | Auto-update UX | n/a | - | tauri.conf.json bundle is inactive; no updater |
