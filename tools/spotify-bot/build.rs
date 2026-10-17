fn main() {
    // Same as stremio-bot: webrtc-sys emits -ObjC with cargo:rustc-link-arg, which Cargo does not pass on to dependents.
    // Without it a libwebrtc static initializer hits an unrecognized selector and aborts before main.
    if std::env::var("CARGO_CFG_TARGET_VENDOR").as_deref() == Ok("apple") {
        println!("cargo:rustc-link-arg=-ObjC");
    }
}
