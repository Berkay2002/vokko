fn main() {
    // sqlx::migrate! embeds the directory at compile time; rebuild when a migration is added or edited.
    println!("cargo:rerun-if-changed=migrations");
}

