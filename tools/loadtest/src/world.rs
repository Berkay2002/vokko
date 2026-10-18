//! Test population: users, guilds and the gateway connections that belong to them.
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::Method;
use serde_json::{Value, json};

use crate::Args;
use crate::api::{Api, User, simulated_addr};
use crate::gateway::{self, Cmd, Conn};
use crate::stats::Shared;

pub const PASSWORD: &str = "loadtest-pass-1";

pub struct Guild {
    pub id: String,
    /// Indexes into `World::users`.
    pub members: Vec<usize>,
    pub channels: Vec<String>,
    /// The default "General" voice channel.
    pub voice: Option<String>,
}

pub struct World {
    pub api: Api,
    pub shared: Arc<Shared>,
    pub users: Vec<User>,
    pub guilds: Vec<Guild>,
    pub conns: Vec<Option<Conn>>,
    pub run_id: String,
}

/// Runs `work` over `items` with at most `limit` in flight and collects the results in completion order.
pub async fn concurrently<T, R, F, Fut>(items: impl IntoIterator<Item = T>, limit: usize, work: F) -> Vec<R>
where
    F: FnMut(T) -> Fut,
    Fut: std::future::Future<Output = R>,
{
    futures_util::stream::iter(items).map(work).buffer_unordered(limit.max(1)).collect().await
}

impl World {
    pub fn connected(&self, guild: &Guild) -> usize {
        guild.members.iter().filter(|index| self.conns[**index].is_some()).count()
    }

    /// Registers `count` users. Without the simulated client addresses the server's `/auth/*` limit (burst 10, then one per
    /// 2 s per address) applies to the whole run, so a 429 is waited out rather than counted as a result.
    pub async fn register_users(api: Api, shared: Arc<Shared>, args: &Args, run_id: &str) -> Result<World, String> {
        let spoof = args.spoof;
        let results = concurrently(0..args.connections, 32, |index| {
            let api = api.clone();
            let name = format!("lt{run_id}_{index}");
            async move {
                let addr = spoof.then(|| simulated_addr(index));
                for attempt in 0..8_u64 {
                    match api.register(&name, PASSWORD, addr.clone(), index).await {
                        Err(failure) if failure.status == 429 => tokio::time::sleep(Duration::from_secs(2 + attempt)).await,
                        other => return other,
                    }
                }
                api.register(&name, PASSWORD, addr, index).await
            }
        })
        .await;
        let mut users: Vec<User> = Vec::new();
        for result in results {
            match result {
                Ok(user) => users.push(user),
                Err(failure) => return Err(format!("registering users failed: {failure}")),
            }
        }
        users.sort_by_key(|user| user.index);
        let conns = users.iter().map(|_| None).collect();
        Ok(World { api, shared, users, guilds: Vec::new(), conns, run_id: run_id.to_owned() })
    }

    /// Guilds of `guild_size` consecutive users: the first creates it (plus two extra text channels and an invite), the rest join.
    pub async fn build_guilds(&mut self, guild_size: usize) -> Result<(), String> {
        let groups: Vec<Vec<usize>> = (0..self.users.len()).collect::<Vec<_>>().chunks(guild_size.max(1)).map(<[usize]>::to_vec).collect();
        let api = self.api.clone();
        let users = self.users.clone();
        let run_id = self.run_id.clone();
        let results = concurrently(groups.into_iter().enumerate(), 8, |(number, members)| {
            let (api, users, run_id) = (api.clone(), users.clone(), run_id.clone());
            async move {
                let owner = &users[members[0]];
                let created = api.call("create_guild", Method::POST, "/guilds", Some(owner), Some(json!({"name": format!("lt-{run_id}-{number}")}))).await;
                let guild_id = created.map_err(|failure| format!("create guild: {failure}"))?.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
                let listed = api.call("list_channels", Method::GET, &format!("/guilds/{guild_id}/channels"), Some(owner), None).await;
                let listed = listed.map_err(|failure| format!("list channels: {failure}"))?;
                let of_type = |kind: u64| -> Vec<String> {
                    listed
                        .as_array()
                        .map(|all| {
                            all.iter()
                                .filter(|channel| channel.get("type").and_then(Value::as_u64) == Some(kind))
                                .filter_map(|c| c.get("id").and_then(Value::as_str))
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_default()
                };
                let mut channels = of_type(0);
                let voice = of_type(2).into_iter().next();
                for name in ["lt-a", "lt-b"] {
                    let extra = api
                        .call("create_channel", Method::POST, &format!("/guilds/{guild_id}/channels"), Some(owner), Some(json!({"name": name, "type": 0})))
                        .await;
                    if let Some(id) = extra.map_err(|failure| format!("create channel: {failure}"))?.get("id").and_then(Value::as_str) {
                        channels.push(id.to_owned());
                    }
                }
                let first = channels.first().ok_or("guild has no text channel")?.clone();
                let invite = api.call("create_invite", Method::POST, &format!("/channels/{first}/invites"), Some(owner), Some(json!({"max_uses": 0}))).await;
                let code = invite.map_err(|failure| format!("create invite: {failure}"))?.get("code").and_then(Value::as_str).unwrap_or_default().to_owned();
                let joins = concurrently(members.iter().skip(1).copied(), 32, |member| {
                    let (api, user, code) = (api.clone(), users[member].clone(), code.clone());
                    async move { api.call("accept_invite", Method::POST, &format!("/invites/{code}"), Some(&user), None).await.map(|_| ()) }
                })
                .await;
                if let Some(Err(failure)) = joins.into_iter().find(Result::is_err) {
                    return Err(format!("accept invite: {failure}"));
                }
                Ok::<Guild, String>(Guild { id: guild_id, members, channels, voice })
            }
        })
        .await;
        for result in results {
            self.guilds.push(result?);
        }
        Ok(())
    }

    /// Opens a gateway connection for every user (at most `ramp` handshakes at once); returns how many are up.
    pub async fn connect_all(&mut self, ramp: usize, base: &str) -> usize {
        let results = concurrently(self.users.clone(), ramp, |user| {
            let (shared, base) = (self.shared.clone(), base.to_owned());
            async move {
                let index = user.index;
                (index, gateway::connect(&base, user, shared).await)
            }
        })
        .await;
        for (index, result) in results {
            if let Ok(conn) = result {
                self.conns[index] = Some(conn);
            }
        }
        self.conns.iter().filter(|conn| conn.is_some()).count()
    }

    pub async fn disconnect_all(&mut self) {
        for conn in self.conns.iter().flatten() {
            let _ = conn.tx.send(Cmd::Stop);
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        for conn in self.conns.iter_mut().filter_map(Option::take) {
            let left = deadline.saturating_duration_since(Instant::now());
            let _ = tokio::time::timeout(left, conn.task).await;
        }
    }
}
