fn main() {
    // The app's own commands (Claude connect, local sessions) need ACL permissions
    // generated for them.
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
                "local_status",
                "local_claude_login",
                "local_claude_login_cancel",
                "local_codex_login",
                "local_codex_login_cancel",
                "local_claude_setup",
                "local_pick_folder",
                "local_check_folder",
                "local_clone_repo",
                "local_list_sessions",
                "local_agent_request",
                "local_socket_open",
                "local_socket_send",
                "local_socket_close",
                "import_scan",
                "import_session",
                "import_environment",
                "update_status",
                "restart_to_update",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
