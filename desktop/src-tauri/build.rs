const APP_COMMANDS: &[&str] = &[
  "desktop_request",
  "desktop_observe",
  "desktop_unobserve",
  "desktop_pick_file",
];

fn main() {
  let attributes = tauri_build::Attributes::new()
    .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
  tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
