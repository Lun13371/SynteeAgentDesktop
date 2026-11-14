use std::io::{self, BufRead, Stdout, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::thread;

use serde_json::Value;

use crate::commands::{dispatch, CommandOutcome};
use crate::common::config::MAX_PROTOCOL_LINE_BYTES;
use crate::common::error::{Result, SidecarError};
use crate::protocol::{Request, Response};

/// Methods that may run off the reader thread.
///
/// The reader loop is synchronous by design: a `semanticIndex` cycle holds a
/// SQLite transaction, and letting two of those interleave would be worse than
/// a queue. But that same queue would put a `tokensCountBatch` on the chat send
/// path behind a long cycle. These methods are pure and read-only, so they are
/// handed to a small worker pool instead. Responses are matched by `id`, so
/// out-of-order replies are already handled by the TypeScript client.
///
/// `semanticEmbed`/`semanticSearch` are here for the same reason: a background
/// `semanticIndex` cycle can occupy the reader thread for up to its budget
/// (60 s), and recall_memory must not wait for it to finish. Both share the
/// embedder behind a mutex, so they serialise on inference only, not on the
/// whole cycle.
///
/// `foregroundBusy` must land immediately: it is how the caller tells the
/// indexer to yield. Queued behind a cycle it would only arrive after the work
/// it was meant to interrupt.
const OFF_THREAD_METHODS: &[&str] = &[
    "tokensCount",
    "tokensCountBatch",
    "tokensTruncate",
    "semanticEmbed",
    "semanticSearch",
    "foregroundBusy",
];

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
        // Модель E5 — 399 МБ RSS против 34 МБ без неё. Сторож выгружает её
        // после пяти минут простоя, иначе фоновый процесс висит с полной
        // моделью даже когда за час не было ни одного recall_memory.
        crate::semantic::start_idle_unloader();
        let writer: SharedWriter = Arc::new(Mutex::new(io::stdout()));
        let (sender, receiver) = mpsc::channel::<Request>();
        let receiver = Arc::new(Mutex::new(receiver));
        let pending = Arc::new(AtomicUsize::new(0));
        let workers = spawn_workers(&receiver, &writer, &pending);

        let result = self.read_loop(&sender, &writer, &pending);

        // Dropping the sender ends every worker's recv loop.
        drop(sender);
        for worker in workers {
            let _ = worker.join();
        }
        result
    }

    fn read_loop(
        &self,
        sender: &Sender<Request>,
        writer: &SharedWriter,
        pending: &Arc<AtomicUsize>,
    ) -> Result<()> {
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

            // Ответы фоновых воркеров ещё не записаны — без ожидания shutdown
            // оборвал бы их, и клиент не получил бы результат последнего запроса.
            if request.method == "shutdown" {
                wait_for_pending(pending);
            }

            let request = if OFF_THREAD_METHODS.contains(&request.method.as_str()) {
                // Счётчик растёт ДО отправки: воркер может ответить быстрее,
                // чем мы вернёмся из send, и декремент обогнал бы инкремент.
                pending.fetch_add(1, Ordering::SeqCst);
                // Worker pool is gone only during teardown; serve inline instead
                // of dropping the request.
                match sender.send(request) {
                    Ok(()) => continue,
                    Err(mpsc::SendError(returned)) => {
                        pending.fetch_sub(1, Ordering::SeqCst);
                        returned
                    }
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

/// Сколько ждать ответов фоновых воркеров при shutdown.
const PENDING_DRAIN_TIMEOUT_MS: u64 = 20_000;

/// Ждёт, пока воркеры запишут все выданные им ответы.
///
/// Без этого shutdown мог обогнать semanticEmbed или tokensCountBatch: запрос
/// уже в очереди пула, а процесс уже завершается — клиент остаётся без ответа
/// и трактует это как таймаут.
fn wait_for_pending(pending: &Arc<AtomicUsize>) {
    let started = Instant::now();
    while pending.load(Ordering::SeqCst) > 0 {
        if started.elapsed() >= Duration::from_millis(PENDING_DRAIN_TIMEOUT_MS) {
            eprintln!("sidecar: shutdown timed out waiting for in-flight requests");
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn spawn_workers(
    receiver: &Arc<Mutex<Receiver<Request>>>,
    writer: &SharedWriter,
    pending: &Arc<AtomicUsize>,
) -> Vec<thread::JoinHandle<()>> {
    (0..WORKER_THREADS)
        .map(|index| {
            let receiver = Arc::clone(receiver);
            let writer = Arc::clone(writer);
            let pending = Arc::clone(pending);
            thread::Builder::new()
                .name(format!("sidecar-worker-{index}"))
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
                    let written = write_response(&writer, &response);
                    // Декремент после записи: shutdown ждёт именно записанных
                    // ответов, а не просто обработанных запросов.
                    pending.fetch_sub(1, Ordering::SeqCst);
                    if let Err(error) = written {
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
        SidecarError::Model(_) => "model_error",
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufReader, Cursor};

    use super::{read_bounded_line, ReadLine};
    use crate::common::config::MAX_PROTOCOL_LINE_BYTES;

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
    fn semantic_and_foreground_methods_bypass_the_reader_queue() {
        use super::OFF_THREAD_METHODS;
        // Поиск не должен ждать конца цикла индексации, а сигнал о занятости
        // пользователя — тем более: именно он этот цикл и останавливает.
        for method in ["semanticEmbed", "semanticSearch", "foregroundBusy"] {
            assert!(
                OFF_THREAD_METHODS.contains(&method),
                "{method} must run off the reader thread"
            );
        }
        // Сам цикл индексации остаётся серийным: один писатель в SQLite.
        assert!(!OFF_THREAD_METHODS.contains(&"semanticIndex"));
    }

    #[test]
    fn line_reader_accepts_crlf_without_unbounded_growth() {
        let mut reader = BufReader::new(Cursor::new(b"{}\r\n".to_vec()));
        assert!(
            matches!(read_bounded_line(&mut reader).unwrap(), ReadLine::Text(line) if line == "{}")
        );
    }
}
