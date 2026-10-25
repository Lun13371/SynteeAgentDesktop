use std::process;

use syntee_sidecar::error::Result;
use syntee_sidecar::runtime::Runtime;

fn main() {
    if let Err(error) = run() {
        eprintln!("[syntee-sidecar] fatal: {error}");
        process::exit(1);
    }
}

fn run() -> Result<()> {
    Runtime::new().run()
}
