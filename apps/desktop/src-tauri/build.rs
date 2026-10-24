use std::{env, path::PathBuf, process::Command};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let desktop_dir = manifest_dir.join("..");
    let bundle_script = desktop_dir.join("scripts/build-youtube-botguard.mjs");
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR");
    let status = Command::new("node")
        .arg(bundle_script)
        .current_dir(&desktop_dir)
        .env("SEAMIND_BOTGUARD_OUT_DIR", &out_dir)
        .status()
        .expect("run YouTube BotGuard runtime bundler");
    if !status.success() {
        panic!("YouTube BotGuard runtime bundling failed");
    }

    println!("cargo:rerun-if-changed=../src/youtube-botguard-runtime.ts");
    println!("cargo:rerun-if-changed=../scripts/build-youtube-botguard.mjs");
    println!("cargo:rerun-if-changed=../../pnpm-lock.yaml");
    tauri_build::build()
}
