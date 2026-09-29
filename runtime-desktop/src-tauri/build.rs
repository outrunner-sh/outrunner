fn main() {
    // The Claude connect commands need ACL permissions generated for them.
    //
    // App-defined commands are implicitly allowed for local content, but this
    // window shows a REMOTE origin (the hosted web UI), and every IPC call from
    // a remote origin is checked against the capability. Without a declared
    // permission the call is rejected with "not allowed. Plugin not found" —
    // Tauri falls back to looking for a plugin of that name.
    //
    // `commands()` generates an `allow-$command` / `deny-$command` pair per
    // entry, which capabilities/default.json then grants.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "connect_claude_start",
                "connect_claude_submit",
                "connect_claude_poll",
                "connect_claude_debug",
                "connect_claude_cancel",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
