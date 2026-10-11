use axum::Router;

use crate::state::AppState;

mod attachments;
pub mod auth;
mod channels;
mod follows;
mod forums;
mod gifs;
pub mod guild_layout;
mod guilds;
pub mod invites;
pub mod messages;
pub mod moderation;
mod onboarding;
mod overwrites;
mod reactions;
pub mod relationships;
mod saved;
pub mod scheduled_events;
mod search;
mod stickers;
mod suggestions;
mod threads;
mod users;

pub fn api(max_upload_bytes: usize) -> Router<AppState> {
    Router::new()
        .merge(auth::routes())
        .merge(crate::account::routes())
        .merge(users::routes())
        .merge(guild_layout::routes())
        .merge(guilds::routes())
        .merge(moderation::routes())
        .merge(channels::routes())
        .merge(overwrites::routes())
        .merge(invites::routes())
        .merge(relationships::routes())
        .merge(messages::routes())
        .merge(reactions::routes())
        .merge(search::routes())
        .merge(scheduled_events::routes())
        .merge(onboarding::routes())
        .merge(suggestions::routes())
        .merge(saved::routes())
        .merge(gifs::routes())
        .merge(stickers::routes())
        .merge(crate::voice::status::routes())
        .merge(threads::routes())
        .merge(forums::routes())
        .merge(follows::routes())
        .merge(attachments::routes(max_upload_bytes))
}
