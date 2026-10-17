fn main() {
    // webrtc-sys emits -ObjC with cargo:rustc-link-arg, which Cargo does not pass on to dependents.
    // Without it the linker drops the Objective-C category members of libwebrtc.a (NSString+StdString) and a static
    // initializer (RTCH264ProfileLevelId.mm) hits an unrecognized selector and aborts before main.
    if std::env::var("CARGO_CFG_TARGET_VENDOR").as_deref() == Ok("apple") {
        println!("cargo:rustc-link-arg=-ObjC");
    }
}
