use std::io::{self, BufRead, Stdout, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::Value;

use crate::commands::{dispatch, CommandOutcome};
use crate::config::MAX_PROTOCOL_LINE_BYTES;
use crate::error::{Result, SidecarError};
use crate::protocol::{Request, Response};

/// Methods that may run off the reader thread.
///
/// The reader loop is synchronous by design: indexing holds a walk and a SQLite
/// transaction, and letting two of those interleave would be worse than a
/// queue. But that same queue would put a `tokensCountBatch` on the chat send
/// path behind a five-thousand-file walk. These methods are pure and read-only,
/// so they are handed to a small worker pool instead. Responses are matched by
/// `id`, so out-of-order replies are already handled by the TypeScript client.
const OFF_THREAD_METHODS: &[&str] = &["tokensCount", "tokensCountBatch", "tokensTruncate"];

/// Two is enough: token requests are short and rare, and more threads would only
/// contend on the stdout mutex.
const WORKER_THREADS: usize = 2;

type SharedWriter = Arc<Mutex<Stdout>>;

/// JSON Lines runtime. stdout is reserved for protocol responses; diagnostics go to stderr.
pub struct Runtime;

impl Default for Runtime {
    fn default() -> Self {
        Self::new()
    }
}

impl Runtime {
    pub fn new() -> Self {
        Self
    }

    pub fn run(&self) -> Result<()> {
        let writer: SharedWriter = Arc::new(Mutex::new(io::stdout()));
        let (sender, receiver) = mpsc::channel::<Request>();
        let receiver = Arc::new(Mutex::new(receiver));
        let workers = spawn_workers(&receiver, &writer);

        let result = self.read_loop(&sender, &writer);

        // Dropping the sender ends every worker's recv loop.
        drop(sender);
        for worker in workers {
            let _ = worker.join();
        }
        result
    }

    fn read_loop(&self, sender: &Sender<Request>, writer: &SharedWriter) -> Result<()> {
        let stdin = io::stdin();
        let mut input = stdin.lock();
        loop {
            let line = match read_bounded_line(&mut input)? {
                ReadLine::Eof => break,
                ReadLine::TooLarge => {
                    let response = Response::failure(
                        Value::Null,
                        "request_too_large",
                        format!("request exceeds {MAX_PROTOCOL_LINE_BYTES} bytes"),
                    );
                    write_response(writer, &response)?;
                    continue;
                }
                ReadLine::Text(line) => line,
            };
            if line.trim().is_empty() {
                continue;
            }

            let request: Request = match serde_json::from_str(&line) {
                Ok(request) => request,
                Err(error) => {
                    let response =
                        Response::failure(Value::Null, "invalid_json", error.to_string());
                    write_response(writer, &response)?;
                    continue;
                }
            };

            let request = if OFF_THREAD_METHODS.contains(&request.method.as_str()) {
                // Worker pool is gone only during teardown; serve inline instead
                // of dropping the request.
                match sender.send(request) {
                    Ok(()) => continue,
                    Err(mpsc::SendError(returned)) => returned,
                }
            } else {
                request
            };

            let id = request.id.clone();
            match dispatch(request) {
                Ok(CommandOutcome { result, shutdown }) => {
                    write_response(writer, &Response::success(id, result))?;
                    if shutdown {
                        break;
                    }
                }
                Err(error) => {
                    let response = Response::failure(id, error_code(&error), error.to_string());
                    write_response(writer, &response)?;
                }
            }
        }
        Ok(())
    }
}

fn spawn_workers(
    receiver: &Arc<Mutex<Receiver<Request>>>,
    writer: &SharedWriter,
) -> Vec<thread::JoinHandle<()>> {
    (0..WORKER_THREADS)
        .map(|index| {
            let receiver = Arc::clone(receiver);
            let writer = Arc::clone(writer);
            thread::Builder::new()
                .name(format!("sidecar-tokens-{index}"))
                .spawn(move || loop {
                    // The lock is held only while waiting for the next job, so
                    // exactly one worker blocks on recv at a time.
                    let job = {
                        let guard = match receiver.lock() {
                            Ok(guard) => guard,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        guard.recv()
                    };
                    let Ok(request) = job else { break };
                    let id = request.id.clone();
                    let response = match dispatch(request) {
                        Ok(CommandOutcome { result, .. }) => Response::success(id, result),
                        Err(error) => Response::failure(id, error_code(&error), error.to_string()),
                    };
                    if let Err(error) = write_response(&writer, &response) {
                        eprintln!("sidecar: failed to write response: {error}");
                        break;
                    }
                })
                .expect("spawn token worker")
        })
        .collect()
}

enum ReadLine {
    Eof,
    TooLarge,
    Text(String),
}

fn read_bounded_line(reader: &mut impl BufRead) -> Result<ReadLine> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if bytes.is_empty() { Ok(ReadLine::Eof) } else { decode_line(bytes) };
        }
        if bytes.len() == MAX_PROTOCOL_LINE_BYTES {
            if available[0] == b'\n' {
                reader.consume(1);
                return decode_line(bytes);
            }
            discard_until_newline(reader)?;
            return Ok(ReadLine::TooLarge);
        }
        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            if bytes.len().saturating_add(newline) > MAX_PROTOCOL_LINE_BYTES {
                discard_until_newline(reader)?;
                return Ok(ReadLine::TooLarge);
            }
            bytes.extend_from_slice(&available[..newline]);
            reader.consume(newline + 1);
            return decode_line(bytes);
        }
        let remaining = MAX_PROTOCOL_LINE_BYTES - bytes.len();
        if available.len() > remaining {
            bytes.extend_from_slice(&available[..remaining]);
            reader.consume(remaining);
            discard_until_newline(reader)?;
            return Ok(ReadLine::TooLarge);
        }
        bytes.extend_from_slice(available);
        let length = available.len();
        reader.consume(length);
    }
}

fn discard_until_newline(reader: &mut impl BufRead) -> Result<()> {
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return Ok(());
        }
        let end =
            chunk.iter().position(|byte| *byte == b'\n').map_or(chunk.len(), |index| index + 1);
        let finished = end < chunk.len();
        reader.consume(end);
        if finished {
            return Ok(());
        }
    }
}

fn decode_line(mut bytes: Vec<u8>) -> Result<ReadLine> {
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    let text = String::from_utf8(bytes)
        .map_err(|error| {
            SidecarError::InvalidRequest(format!("request is not valid UTF-8: {error}"))
        })?
        .trim_start_matches('\u{feff}')
        .to_owned();
    Ok(ReadLine::Text(text))
}

/// One response per line. The mutex is what keeps the reader thread and the
/// worker pool from interleaving halves of two JSON documents.
fn write_response(writer: &SharedWriter, response: &Response) -> Result<()> {
    let mut stdout = match writer.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    serde_json::to_writer(&mut *stdout, response)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}

fn error_code(error: &SidecarError) -> &'static str {
    match error {
        SidecarError::Io(_) => "io_error",
        SidecarError::Json(_) => "json_error",
        SidecarError::Sqlite(_) => "sqlite_error",
        SidecarError::InvalidRequest(_) => "invalid_request",
        SidecarError::UnsupportedMethod(_) => "unsupported_method",
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufReader, Cursor};

    use super::{read_bounded_line, ReadLine};
    use crate::config::MAX_PROTOCOL_LINE_BYTES;

    #[test]
    fn oversized_line_is_discarded_before_next_request() {
        let input = format!("{}\n{{\"next\":true}}\n", "x".repeat(MAX_PROTOCOL_LINE_BYTES + 1));
        let mut reader = BufReader::new(Cursor::new(input.into_bytes()));
        assert!(matches!(read_bounded_line(&mut reader).unwrap(), ReadLine::TooLarge));
        assert!(matches!(
            read_bounded_line(&mut reader).unwrap(),
            ReadLine::Text(line) if line == "{\"next\":true}"
        ));
    }

    #[test]
    fn line_reader_accepts_crlf_without_unbounded_growth() {
        let mut reader = BufReader::new(Cursor::new(b"{}\r\n".to_vec()));
        assert!(
            matches!(read_bounded_line(&mut reader).unwrap(), ReadLine::Text(line) if line == "{}")
        );
    }
}
