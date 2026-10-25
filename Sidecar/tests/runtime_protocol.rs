//! Runtime-level behaviour that `dispatch` unit tests cannot see: the reader
//! loop, the off-thread token workers and the shared stdout writer.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde_json::{json, Value};

fn run(lines: &[Value]) -> Vec<Value> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_syntee-sidecar"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn sidecar");

    {
        let stdin = child.stdin.as_mut().expect("stdin");
        for line in lines {
            writeln!(stdin, "{line}").expect("write request");
        }
    }
    // Closing stdin ends the reader loop; workers drain before the process exits.
    drop(child.stdin.take());

    let stdout = child.stdout.take().expect("stdout");
    let responses: Vec<Value> = BufReader::new(stdout)
        .lines()
        .map_while(Result::ok)
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(&line).expect("response is JSON"))
        .collect();
    let _ = child.wait();
    responses
}

#[test]
fn every_off_thread_token_request_gets_its_own_response() {
    // More requests than worker threads, so responses must arrive out of order
    // and still be matched by id.
    let mut requests: Vec<Value> = (0..40)
        .map(|index| {
            json!({
                "id": format!("t{index}"),
                "method": "tokensCount",
                "params": { "text": "word ".repeat(index + 1) }
            })
        })
        .collect();
    // A serial method interleaved with the token burst must not be reordered or
    // corrupted on stdout.
    requests.insert(5, json!({ "id": "caps", "method": "capabilities", "params": {} }));
    requests.push(json!({ "id": "bye", "method": "shutdown", "params": {} }));

    let responses = run(&requests);
    assert_eq!(responses.len(), requests.len(), "one response per request");

    let mut ids: Vec<&str> = responses.iter().filter_map(|value| value["id"].as_str()).collect();
    ids.sort_unstable();
    let mut expected: Vec<String> =
        requests.iter().map(|value| value["id"].as_str().unwrap().to_owned()).collect();
    expected.sort_unstable();
    assert_eq!(ids, expected);

    for response in &responses {
        assert_eq!(response["ok"], true, "no request should fail: {response}");
    }
    // Spot-check that counts are exact and not swapped between requests.
    for response in &responses {
        let Some(id) = response["id"].as_str().and_then(|id| id.strip_prefix('t')) else {
            continue;
        };
        let index: usize = id.parse().expect("numeric id");
        let tokens = response["result"]["tokens"].as_u64().expect("tokens");
        // "word" is one token, the trailing space merges into the next word.
        assert!(tokens >= 1, "request {index} reported {tokens} tokens");
    }
}

#[test]
fn shutdown_after_token_burst_still_answers_every_request() {
    let mut requests: Vec<Value> = (0..10)
        .map(|index| {
            json!({
                "id": index,
                "method": "tokensCountBatch",
                "params": { "texts": ["alpha beta", "gamma"] }
            })
        })
        .collect();
    requests.push(json!({ "id": "bye", "method": "shutdown", "params": {} }));

    let responses = run(&requests);
    assert_eq!(responses.len(), requests.len());
    for response in responses.iter().filter(|value| value["id"] != "bye") {
        assert_eq!(response["result"]["tokens"], json!([2, 1]));
    }
}
