//! Registration rules shared by password sign-up, OAuth sign-up and account editing.
use time::{Date, Month, OffsetDateTime};

use crate::error::{ApiErr, ApiResult};

pub const USERNAME_RULES: &str = "Must be 2-32 characters: lowercase letters, numbers, '_' and '.'.";
pub const WEAK_PASSWORD: &str = "Password is too weak or common to use.";

/// Lowercase a-z, 0-9, `_` and `.`, 2-32 characters, never two dots in a row.
pub fn username_problem(username: &str) -> Option<&'static str> {
    if !(2..=32).contains(&username.len()) || !username.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '.') {
        return Some(USERNAME_RULES);
    }
    if username.contains("..") {
        return Some("Can't contain two dots in a row.");
    }
    None
}

/// Trims and lowercases a requested username, then validates it (50035 `username`).
pub fn username(raw: &str) -> ApiResult<String> {
    let username = raw.trim().to_lowercase();
    match username_problem(&username) {
        Some(message) => Err(ApiErr::invalid("username", message)),
        None => Ok(username),
    }
}

pub fn email(raw: &str) -> ApiResult<String> {
    let email = raw.trim().to_lowercase();
    let well_formed = email.len() <= 254 && !email.chars().any(char::is_whitespace) && email.parse::<lettre::Address>().is_ok();
    if well_formed { Ok(email) } else { Err(ApiErr::invalid("email", "Not a well formed email address.")) }
}

/// The most common passwords that still pass the length rule (lowercase).
const COMMON: &[&str] = &[
    "password",
    "password1",
    "password12",
    "password123",
    "12345678",
    "123456789",
    "1234567890",
    "qwertyuiop",
    "qwerty123",
    "11111111",
    "00000000",
    "iloveyou",
    "sunshine",
    "princess",
    "football",
    "baseball",
    "superman",
    "trustno1",
    "letmein1",
    "welcome1",
    "admin123",
    "abc12345",
    "abcd1234",
    "1q2w3e4r",
    "1qaz2wsx",
    "zaq12wsx",
    "passw0rd",
    "p@ssw0rd",
    "qwerty12",
    "asdfghjkl",
    "starwars",
    "whatever",
    "dragon12",
    "monkey12",
    "87654321",
    "12341234",
    "11223344",
    "a1b2c3d4",
    "changeme",
    "vokko123",
    "discord1",
    "discord123",
];

/// Why `password` is not acceptable, or `None`. `personal` are the username and email the password must not contain.
pub fn password_problem(password: &str, personal: &[&str]) -> Option<&'static str> {
    let length = password.chars().count();
    if !(8..=128).contains(&length) {
        return Some("Must be between 8 and 128 in length.");
    }
    let lower = password.to_lowercase();
    let distinct = lower.chars().collect::<std::collections::HashSet<_>>().len();
    let personal_hit = personal.iter().map(|value| value.split('@').next().unwrap_or_default()).any(|value| value.len() >= 3 && lower.contains(value));
    if COMMON.contains(&lower.as_str()) || distinct < 4 || personal_hit {
        return Some(WEAK_PASSWORD);
    }
    None
}

pub fn password(password: &str, personal: &[&str]) -> ApiResult<()> {
    match password_problem(password, personal) {
        Some(message) => Err(ApiErr::invalid("password", message)),
        None => Ok(()),
    }
}

/// Parses `YYYY-MM-DD`.
pub fn parse_date(raw: &str) -> Option<Date> {
    let mut parts = raw.trim().splitn(3, '-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u8 = parts.next()?.parse().ok()?;
    let day: u8 = parts.next()?.parse().ok()?;
    Date::from_calendar_date(year, Month::try_from(month).ok()?, day).ok()
}

/// Whole years between `birth` and `today`.
pub fn age_on(birth: Date, today: Date) -> i32 {
    let mut years = today.year() - birth.year();
    if (today.month() as u8, today.day()) < (birth.month() as u8, birth.day()) {
        years -= 1;
    }
    years
}

/// Validates a date of birth against the instance's minimum age (50035 `date_of_birth`).
pub fn date_of_birth(raw: Option<&str>, min_age: u8) -> ApiResult<Date> {
    let invalid = |message: &str| ApiErr::invalid("date_of_birth", message);
    let Some(raw) = raw.filter(|raw| !raw.trim().is_empty()) else { return Err(invalid("Required.")) };
    let birth = parse_date(raw).ok_or_else(|| invalid("Not a valid date."))?;
    let today = OffsetDateTime::now_utc().date();
    let age = age_on(birth, today);
    if birth > today || age > 150 {
        return Err(invalid("Not a valid date."));
    }
    if age < i32::from(min_age) {
        return Err(invalid(&format!("You need to be {min_age} or older to use Vokko.")));
    }
    Ok(birth)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usernames() {
        assert!(username_problem("sam").is_none());
        assert!(username_problem("a.b_c9").is_none());
        assert_eq!(username_problem("a..b"), Some("Can't contain two dots in a row."));
        assert!(username_problem("x").is_some());
        assert!(username_problem(&"x".repeat(33)).is_some());
        assert!(username_problem("Upper").is_some());
        assert!(username_problem("with space").is_some());
        assert_eq!(username("  SaM ").ok(), Some("sam".to_owned()));
    }

    #[test]
    fn emails() {
        assert_eq!(email(" Mixed@Example.TEST ").ok(), Some("mixed@example.test".to_owned()));
        assert!(email("a.b+c@example.com").is_ok());
        assert!(email("x<victim@example.com>").is_err());
        assert!(email("(c)a@b.com").is_err());
        assert!(email("a@b.com>").is_err());
        assert!(email("\"a b\"@x.io").is_err());
        assert!(email("a@b@c.io").is_err());
    }

    #[test]
    fn passwords() {
        assert!(password_problem("correct horse battery", &["sam", "sam@example.test"]).is_none());
        assert_eq!(password_problem("short", &[]), Some("Must be between 8 and 128 in length."));
        assert_eq!(password_problem("Password123", &[]), Some(WEAK_PASSWORD));
        assert_eq!(password_problem("aaaaaaaaaaaa", &[]), Some(WEAK_PASSWORD));
        assert_eq!(password_problem("my-sam-secret", &["sam"]), Some(WEAK_PASSWORD));
        assert_eq!(password_problem("alice-in-chains", &["bob", "alice@x.io"]), Some(WEAK_PASSWORD));
    }

    #[test]
    fn ages() {
        let date = |y, m, d| parse_date(&format!("{y:04}-{m:02}-{d:02}")).expect("date");
        assert_eq!(age_on(date(2000, 5, 10), date(2013, 5, 9)), 12);
        assert_eq!(age_on(date(2000, 5, 10), date(2013, 5, 10)), 13);
        assert_eq!(age_on(date(2000, 2, 29), date(2013, 2, 28)), 12);
        assert_eq!(age_on(date(2000, 2, 29), date(2013, 3, 1)), 13);
        assert!(parse_date("2001-02-29").is_none());
        assert!(parse_date("2001-13-01").is_none());
        assert!(parse_date("yesterday").is_none());
        assert!(date_of_birth(Some("1990-01-01"), 13).is_ok());
        assert!(date_of_birth(None, 13).is_err());
        assert!(date_of_birth(Some("3000-01-01"), 13).is_err());
        let today = OffsetDateTime::now_utc().date();
        let young = format!("{:04}-01-01", today.year() - 5);
        assert!(date_of_birth(Some(&young), 13).is_err());
        assert!(date_of_birth(Some(&young), 0).is_ok());
    }
}
