use axum::Router;

use crate::state::AppState;

mod attachments;
mod auth;
mod channels;
mod guilds;
mod invites;
pub mod messages;
mod moderation;
mod overwrites;
mod reactions;
pub mod relationships;
mod search;
mod users;

pub fn api(max_upload_bytes: usize) -> Router<AppState> {
    Router::new()
        .merge(auth::routes())
        .merge(users::routes())
        .merge(guilds::routes())
        .merge(moderation::routes())
        .merge(channels::routes())
        .merge(overwrites::routes())
        .merge(invites::routes())
        .merge(relationships::routes())
        .merge(messages::routes())
        .merge(reactions::routes())
        .merge(search::routes())
        .merge(attachments::routes(max_upload_bytes))
}
