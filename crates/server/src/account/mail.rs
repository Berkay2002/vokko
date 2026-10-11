//! Outgoing mail: SMTP when `VOKKO_SMTP_*` is set, otherwise the log (self-hosters copy links from there).
//! Mails are sent in the background so a request never waits on (or reveals anything through) the mail server.
use std::sync::{Arc, Mutex};

use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use super::config::{MailConfig, SmtpConfig, SmtpSecurity};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mail {
    pub to: String,
    pub subject: String,
    pub body: String,
}

enum Transport {
    Log,
    Memory(Arc<Mutex<Vec<Mail>>>, std::time::Duration),
    Smtp { transport: Box<AsyncSmtpTransport<Tokio1Executor>>, from: Box<Mailbox> },
}

pub struct Mailer(Transport);

fn smtp(config: &SmtpConfig) -> Result<Transport, String> {
    let builder = match config.security {
        SmtpSecurity::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&config.host).map_err(|error| error.to_string())?,
        SmtpSecurity::StartTls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.host).map_err(|error| error.to_string())?,
        SmtpSecurity::None => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&config.host),
    };
    let mut builder = builder.port(config.port);
    if let (Some(username), Some(password)) = (&config.username, &config.password) {
        builder = builder.credentials(Credentials::new(username.clone(), password.clone()));
    }
    let from = config.from.parse::<Mailbox>().map_err(|error| format!("VOKKO_SMTP_FROM is not a valid address: {error}"))?;
    Ok(Transport::Smtp { transport: Box::new(builder.build()), from: Box::new(from) })
}

/// Checks SMTP settings at start-up (`Config::from_env` fails with the message), so a typo never silently
/// degrades to logging links.
pub fn check_smtp(config: &SmtpConfig) -> Result<(), String> {
    smtp(config).map(|_| ())
}

impl Mailer {
    pub fn new(config: &MailConfig) -> Self {
        let transport = match config {
            MailConfig::Log => Transport::Log,
            MailConfig::Memory => Transport::Memory(Arc::default(), std::time::Duration::ZERO),
            MailConfig::SlowMemory(delay) => Transport::Memory(Arc::default(), *delay),
            MailConfig::Smtp(smtp_config) => match smtp(smtp_config) {
                Ok(transport) => transport,
                Err(error) => {
                    tracing::error!("SMTP disabled, mails go to the log: {error}");
                    Transport::Log
                }
            },
        };
        Self(transport)
    }

    pub fn send(&self, to: &str, subject: &str, body: String) {
        let mail = Mail { to: to.to_owned(), subject: subject.to_owned(), body };
        match &self.0 {
            Transport::Log => tracing::info!("mail (SMTP not configured) to {}: {}\n{}", mail.to, mail.subject, mail.body),
            Transport::Memory(sent, delay) => {
                // a slow mail server (tests): the caller waits, like with a blocking transport
                if !delay.is_zero() {
                    std::thread::sleep(*delay);
                }
                sent.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(mail)
            }
            Transport::Smtp { transport, from } => {
                let message = mail.to.parse::<Mailbox>().map_err(|error| error.to_string()).and_then(|to| {
                    Message::builder()
                        .from(Mailbox::clone(from))
                        .to(to)
                        .subject(mail.subject.clone())
                        .body(mail.body.clone())
                        .map_err(|error| error.to_string())
                });
                let message = match message {
                    Ok(message) => message,
                    Err(error) => {
                        tracing::warn!("mail to {} not sent: {error}", mail.to);
                        return;
                    }
                };
                let transport = AsyncSmtpTransport::clone(transport);
                tokio::spawn(async move {
                    if let Err(error) = transport.send(message).await {
                        tracing::warn!("mail to {} failed: {error}", mail.to);
                    }
                });
            }
        }
    }

    /// Mails kept by the in-memory transport (tests); empty for the others.
    pub fn sent(&self) -> Vec<Mail> {
        match &self.0 {
            Transport::Memory(sent, _) => sent.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone(),
            _ => Vec::new(),
        }
    }
}
