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
    Runtime::new().run()
}
