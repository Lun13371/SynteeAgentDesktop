use std::process;

use syntee_sidecar::common::error::Result;
use syntee_sidecar::common::runtime::Runtime;

fn main() {
    if let Err(error) = run() {
        eprintln!("[syntee-sidecar] fatal: {error}");
        process::exit(1);
    }
}

fn run() -> Result<()> {
    lower_process_priority();
    Runtime::new().run()
}

/// Sidecar — фоновый помощник: карта, семантика, отработка запросов тула.
/// BELOW_NORMAL: когда ПК свободен — планировщик даёт все ядра и прогрев
/// семантики идёт на полной скорости; когда пользователь активно работает —
/// Windows выбирает foreground-приложения, и sidecar становится незаметным.
/// Ноль зависимостей: kernel32 напрямую.
#[cfg(target_os = "windows")]
fn lower_process_priority() {
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x4000;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut core::ffi::c_void;
        fn SetPriorityClass(h_process: *mut core::ffi::c_void, priority_class: u32) -> i32;
    }
    unsafe {
        SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
    }
}

#[cfg(not(target_os = "windows"))]
fn lower_process_priority() {}
