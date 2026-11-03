// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = object0_lib::portable_update::run_helper_from_args() {
        std::process::exit(code);
    }
    object0_lib::run()
}
