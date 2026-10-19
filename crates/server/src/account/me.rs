//! My Account: account info, username / email / password changes, disable and delete.
use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use vokko_protocol::account::{AccountInfo, EditAccountRequest, EditAccountResponse, PasswordConfirmRequest};
use vokko_protocol::api::{GatewayEvent, GuildMemberRemove, IdOnly, Snowflake};

use super::{rules, send_verification, username_taken};
use crate::auth::{AuthUser, bearer_header, hash_password, hash_token, random_hex, verify_password};
use crate::error::{ApiErr, ApiResult};
use crate::events;
use crate::extract::ApiJson;
use crate::gateway::CLOSE_AUTH_FAILED;
use crate::state::AppState;
use crate::store;

/// A valid argon2id hash nobody knows the password of: verifying against it costs the same as a real check.
pub const DUMMY_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

pub async fn account_info(state: &AppState, user_id: i64) -> ApiResult<AccountInfo> {
    let (email, pending_email, verified, has_password, mfa_enabled): (String, Option<String>, bool, bool, bool) =
        sqlx::query_as("SELECT email, pending_email, email_verified, password_hash IS NOT NULL, mfa_secret IS NOT NULL FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(ApiErr::unauthorized)?;
    Ok(AccountInfo { email, pending_email, verified, has_password, mfa_enabled })
}

/// Checks the current password (`password` field). Accounts without one pass without it. Wrong passwords are counted
/// per account like second-factor codes (10 in 15 minutes, then 429).
pub async fn confirm_password(state: &AppState, user_id: i64, password: Option<String>) -> ApiResult<()> {
    let (hash,): (Option<String>,) = sqlx::query_as("SELECT password_hash FROM users WHERE id = $1").bind(user_id).fetch_one(&state.db).await?;
    let Some(hash) = hash else { return Ok(()) };
    let mismatch = || ApiErr::invalid("password", "Password does not match.");
    let Some(password) = password.filter(|password| !password.is_empty()) else { return Err(mismatch()) };
    let attempt = super::security::begin_attempt(state, "password_failures", user_id, "Too many wrong passwords. Try again in 15 minutes.").await?;
    let verified = verify_password(password, hash).await;
    // a busy server (429) is not a wrong password: it does not count
    super::security::end_attempt(state, "password_failures", attempt, !matches!(verified, Ok(false))).await?;
    if verified? { Ok(()) } else { Err(mismatch()) }
}

/// Confirms it is really the account owner before a sensitive change. Accounts with a password give it (and with
/// `also_code`, a second factor when two-factor is on). Accounts without one give a second factor when two-factor is on,
/// otherwise their session must have signed in or re-confirmed through a linked provider in the last 5 minutes.
pub async fn confirm_identity(
    state: &AppState,
    user_id: i64,
    headers: &HeaderMap,
    password: Option<String>,
    code: Option<&str>,
    also_code: bool,
) -> ApiResult<()> {
    let (has_password, mfa): (bool, bool) =
        sqlx::query_as("SELECT password_hash IS NOT NULL, mfa_secret IS NOT NULL FROM users WHERE id = $1").bind(user_id).fetch_one(&state.db).await?;
    if has_password {
        confirm_password(state, user_id, password).await?;
        if also_code {
            super::security::require_code(state, user_id, code).await?;
        }
        return Ok(());
    }
    if mfa {
        return super::security::require_code(state, user_id, code).await;
    }
    let token = bearer_header(headers).map(hash_token).ok_or_else(ApiErr::unauthorized)?;
    let (fresh,): (bool,) =
        sqlx::query_as("SELECT EXISTS (SELECT 1 FROM sessions WHERE token_hash = $1 AND user_id = $2 AND reauth_at > now() - interval '5 minutes')")
            .bind(token)
            .bind(user_id)
            .fetch_one(&state.db)
            .await?;
    if fresh { Ok(()) } else { Err(ApiErr::invalid("reauth", "Confirm it's you: sign in again with a linked provider, then retry.")) }
}

/// Drops a pending email change and its verification links (links for `current` itself stay).
pub async fn cancel_email_change(state: &AppState, user_id: i64, current: &str) -> ApiResult<()> {
    sqlx::query("UPDATE users SET pending_email = NULL WHERE id = $1").bind(user_id).execute(&state.db).await?;
    sqlx::query("DELETE FROM email_tokens WHERE user_id = $1 AND purpose = 'verify' AND email <> $2").bind(user_id).bind(current).execute(&state.db).await?;
    Ok(())
}

/// Deletes the user's sessions (all, or all but `keep`) and pending MFA login tickets, and closes their gateway connections with 4004.
pub async fn revoke_sessions(state: &AppState, user_id: i64, keep: Option<&[u8]>) -> ApiResult<()> {
    // a ticket from a login with the old password must not finish into a new session
    sqlx::query("DELETE FROM mfa_tickets WHERE user_id = $1").bind(user_id).execute(&state.db).await?;
    let hashes: Vec<(Vec<u8>,)> = sqlx::query_as("DELETE FROM sessions WHERE user_id = $1 AND ($2::bytea IS NULL OR token_hash <> $2) RETURNING token_hash")
        .bind(user_id)
        .bind(keep)
        .fetch_all(&state.db)
        .await?;
    for (hash,) in hashes {
        state.hub.close_token_sessions(&hash, CLOSE_AUTH_FAILED);
    }
    Ok(())
}

pub async fn get_account(State(state): State<AppState>, AuthUser(user_id): AuthUser) -> ApiResult<Json<AccountInfo>> {
    Ok(Json(account_info(&state, user_id).await?))
}

async fn broadcast_user(state: &AppState, user_id: i64) -> ApiResult<vokko_protocol::api::User> {
    let user = store::user(state, user_id).await?.ok_or_else(ApiErr::unauthorized)?;
    let audience = events::user_audience(state, user_id).await?;
    state.hub.send(&audience, &GatewayEvent::UserUpdate(user.clone()));
    Ok(user)
}

pub async fn edit_account(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    headers: HeaderMap,
    ApiJson(body): ApiJson<EditAccountRequest>,
) -> ApiResult<Json<EditAccountResponse>> {
    let before = account_info(&state, user_id).await?;
    let current = store::user(&state, user_id).await?.ok_or_else(ApiErr::unauthorized)?;
    // validate everything first, so a request either applies completely or not at all
    let username = match &body.username {
        Some(raw) => Some(rules::username(raw)?).filter(|name| *name != current.username),
        None => None,
    };
    let email = match &body.email {
        Some(raw) => Some(rules::email(raw)?).filter(|email| *email != before.email),
        None => None,
    };
    if let Some(new_password) = &body.new_password {
        let name = username.as_deref().unwrap_or(&current.username);
        if let Some(problem) = rules::password_problem(new_password, &[name, email.as_deref().unwrap_or(&before.email)]) {
            return Err(ApiErr::invalid("new_password", problem));
        }
    }
    if username.is_none() && email.is_none() && body.new_password.is_none() {
        return Ok(Json(EditAccountResponse { user: current, account: before }));
    }
    confirm_identity(&state, user_id, &headers, body.password, body.code.as_deref(), false).await?;
    // hashing can answer 429 when the server is busy, so it runs before anything is written or mailed
    let password_hash = match body.new_password {
        Some(new_password) => Some(hash_password(new_password).await?),
        None => None,
    };
    if let Some(email) = &email {
        let (taken,): (bool,) =
            sqlx::query_as("SELECT EXISTS (SELECT 1 FROM users WHERE email = $1 AND id <> $2)").bind(email).bind(user_id).fetch_one(&state.db).await?;
        if taken {
            return Err(ApiErr::invalid("email", "Already taken."));
        }
    }
    if let Some(username) = &username {
        if username_taken(&state, username).await? {
            return Err(ApiErr::invalid("username", "Already taken."));
        }
        let updated = sqlx::query("UPDATE users SET username = $2 WHERE id = $1").bind(user_id).bind(username).execute(&state.db).await;
        match updated {
            Ok(_) => {}
            Err(sqlx::Error::Database(database)) if database.is_unique_violation() => return Err(ApiErr::invalid("username", "Already taken.")),
            Err(error) => return Err(error.into()),
        }
    }
    if let Some(email) = &email {
        sqlx::query("UPDATE users SET pending_email = $2 WHERE id = $1").bind(user_id).bind(email).execute(&state.db).await?;
        send_verification(&state, user_id, email).await?;
        state.accounts.mailer.send(
            &before.email,
            "Your Vokko email is changing",
            format!("Someone asked to change the email of your Vokko account to {email}. It changes once the new address is verified. If this wasn't you, change your password now."),
        );
    }
    if let Some(hash) = password_hash {
        sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1").bind(user_id).bind(hash).execute(&state.db).await?;
        let keep = bearer_header(&headers).map(hash_token);
        revoke_sessions(&state, user_id, keep.as_deref()).await?;
        // a pending reset link would undo this change
        sqlx::query("DELETE FROM email_tokens WHERE user_id = $1 AND purpose = 'reset'").bind(user_id).execute(&state.db).await?;
        // rotating the password (what the "email is changing" notice tells the owner to do) also cancels an email change
        // somebody else started; one requested in this same call stays
        if email.is_none() {
            cancel_email_change(&state, user_id, &before.email).await?;
        }
    }
    let user = if username.is_some() { broadcast_user(&state, user_id).await? } else { current };
    Ok(Json(EditAccountResponse { user, account: account_info(&state, user_id).await? }))
}

pub async fn disable_account(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    headers: HeaderMap,
    ApiJson(body): ApiJson<PasswordConfirmRequest>,
) -> ApiResult<StatusCode> {
    confirm_identity(&state, user_id, &headers, body.password, body.code.as_deref(), true).await?;
    sqlx::query("UPDATE users SET disabled_at = now() WHERE id = $1").bind(user_id).execute(&state.db).await?;
    revoke_sessions(&state, user_id, None).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_account(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    headers: HeaderMap,
    ApiJson(body): ApiJson<PasswordConfirmRequest>,
) -> ApiResult<StatusCode> {
    confirm_identity(&state, user_id, &headers, body.password, body.code.as_deref(), true).await?;
    // who knew the user before: they get the anonymised USER_UPDATE
    let audience = events::user_audience(&state, user_id).await?;
    let mut tx = state.db.begin().await?;
    // claims lock the upload row in the transaction that writes the reference: wait for those in flight so the delete below sees
    // their references, and make later ones find the row gone. Taken before the users lock, in the order the claims take them.
    sqlx::query("SELECT id FROM attachments WHERE uploader_id = $1 AND message_id IS NULL ORDER BY id FOR UPDATE").bind(user_id).execute(&mut *tx).await?;
    // the row lock keeps a guild from being created or transferred to the user halfway through
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE").bind(user_id).execute(&mut *tx).await?;
    let (owned,): (i64,) = sqlx::query_as("SELECT count(*) FROM guilds WHERE owner_id = $1").bind(user_id).fetch_one(&mut *tx).await?;
    if owned > 0 {
        return Err(ApiErr::conflict(40011, "You need to transfer ownership of the servers you own, or delete them, before deleting your account."));
    }
    // the user's applications go with them: bot tokens revoked, bots out of every guild (the soft delete fires no ON DELETE CASCADE)
    let owned_apps: Vec<(i64,)> = sqlx::query_as("SELECT id FROM applications WHERE owner_id = $1").bind(user_id).fetch_all(&mut *tx).await?;
    let mut deleted_apps = Vec::with_capacity(owned_apps.len());
    for (app,) in owned_apps {
        deleted_apps.push(crate::apps::delete_app(&mut tx, app).await?);
    }
    // profile media (avatar, banner, per-server ones) and unsent uploads go with the account; message attachments stay
    let paths: Vec<(Option<String>,)> = sqlx::query_as(
        "SELECT avatar_path FROM users WHERE id = $1 UNION ALL SELECT banner_path FROM users WHERE id = $1 \
         UNION ALL SELECT avatar_path FROM guild_members WHERE user_id = $1 UNION ALL SELECT banner_path FROM guild_members WHERE user_id = $1 \
         UNION ALL SELECT p #>> '{}' FROM users u, jsonb_path_query(u.widgets, '$.**.image_path') p WHERE u.id = $1          UNION ALL SELECT attachment_id::text FROM user_image_history WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await?;
    let profile_ids: Vec<i64> = paths.into_iter().filter_map(|(path,)| path?.split('/').next()?.parse().ok()).collect();
    // their own pictures stop counting as "in use" first; an upload can also be a guild or group icon, a sticker or someone else's picture
    sqlx::query("DELETE FROM user_image_history WHERE user_id = $1").bind(user_id).execute(&mut *tx).await?;
    sqlx::query("UPDATE users SET avatar_path = NULL, banner_path = NULL, widgets = NULL WHERE id = $1").bind(user_id).execute(&mut *tx).await?;
    sqlx::query("UPDATE guild_members SET avatar_path = NULL, banner_path = NULL WHERE user_id = $1").bind(user_id).execute(&mut *tx).await?;
    let media: Vec<(i64,)> = sqlx::query_as(&format!(
        "DELETE FROM attachments a WHERE uploader_id = $1 AND message_id IS NULL AND (id = ANY($2) OR claimed_at IS NULL) AND NOT {} RETURNING id",
        crate::media::IN_USE
    ))
    .bind(user_id)
    .bind(&profile_ids)
    .fetch_all(&mut *tx)
    .await?;
    let guilds: Vec<(i64,)> = sqlx::query_as("DELETE FROM guild_members WHERE user_id = $1 RETURNING guild_id").bind(user_id).fetch_all(&mut *tx).await?;
    sqlx::query("DELETE FROM guild_timeouts WHERE user_id = $1").bind(user_id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM read_states WHERE user_id = $1").bind(user_id).execute(&mut *tx).await?;
    let others: Vec<(i64,)> = sqlx::query_as("DELETE FROM relationships WHERE other_id = $1 RETURNING user_id").bind(user_id).fetch_all(&mut *tx).await?;
    sqlx::query("DELETE FROM relationships WHERE user_id = $1").bind(user_id).execute(&mut *tx).await?;
    let sessions: Vec<(Vec<u8>,)> = sqlx::query_as("DELETE FROM sessions WHERE user_id = $1 RETURNING token_hash").bind(user_id).fetch_all(&mut *tx).await?;
    for table in ["email_tokens", "mfa_backup_codes", "mfa_tickets", "mfa_failures", "password_failures", "oauth_identities", "oauth_results"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE user_id = $1")).bind(user_id).execute(&mut *tx).await?;
    }
    sqlx::query("DELETE FROM oauth_flows WHERE link_user_id = $1").bind(user_id).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE users SET username = $2, email = $3, global_name = 'Deleted User', avatar_path = NULL, banner_color = NULL, bio = NULL, \
         banner_path = NULL, pronouns = NULL, theme_primary = NULL, theme_accent = NULL, avatar_decoration = NULL, profile_effect = NULL, \
         widgets = NULL, nameplate = NULL, name_font = NULL, name_effect = NULL, name_colors = NULL, profile_frame = NULL, primary_guild_id = NULL, password_hash = NULL, mfa_secret = NULL, mfa_last_step = NULL, pending_email = NULL, email_verified = FALSE, date_of_birth = NULL, \
         disabled_at = NULL, deleted_at = now() WHERE id = $1",
    )
    .bind(user_id)
    .bind(format!("deleted_user_{}", random_hex(6)))
    .bind(format!("deleted-{user_id}@deleted.invalid"))
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE presences SET status = 'offline', custom_status = NULL WHERE user_id = $1").bind(user_id).execute(&mut *tx).await?;
    tx.commit().await?;

    // everything below only tells others what already happened
    crate::media::remove_files(&state, &media.into_iter().map(|(id,)| id).collect::<Vec<_>>()).await;
    for (hash,) in sessions {
        state.hub.close_token_sessions(&hash, CLOSE_AUTH_FAILED);
    }
    for app in deleted_apps {
        // the account is already gone: a failed announcement must not turn the delete into an error
        if let Err(error) = crate::apps::announce_deleted_app(&state, app).await {
            tracing::warn!("announcing a deleted application failed: {error:?}");
        }
    }
    let user = store::user(&state, user_id).await?.ok_or_else(ApiErr::internal)?;
    for (guild_id,) in guilds {
        let remaining = crate::access::guild_member_ids(&state, guild_id).await?;
        state.hub.send(&remaining, &GatewayEvent::GuildMemberRemove(GuildMemberRemove { guild_id: Snowflake::from(guild_id), user: user.clone() }));
        crate::presence::announce_leave(&state, guild_id, user_id).await?;
        crate::spotify::membership_changed(&state, guild_id, user_id).await;
    }
    for (other,) in others {
        state.hub.send(&[other], &GatewayEvent::RelationshipRemove(IdOnly { id: Snowflake::from(user_id) }));
    }
    state.hub.send(&audience, &GatewayEvent::UserUpdate(user));
    Ok(StatusCode::NO_CONTENT)
}
