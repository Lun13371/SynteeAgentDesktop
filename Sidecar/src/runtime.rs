use std::io::{self, BufRead, Write};

use serde_json::Value;

use crate::commands::{dispatch, CommandOutcome};
use crate::config::MAX_PROTOCOL_LINE_BYTES;
use crate::error::{Result, SidecarError};
use crate::protocol::{Request, Response};

/// JSON Lines runtime. stdout is reserved for protocol responses; diagnostics go to stderr.
pub struct Runtime;

impl Runtime {
    pub fn new() -> Self {
        Self
    }

    pub fn run(&self) -> Result<()> {
        let stdin = io::stdin();
        let mut stdout = io::BufWriter::new(io::stdout().lock());

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
                    write_response(&mut stdout, &response)?;
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
                    write_response(&mut stdout, &response)?;
                    continue;
                }
            };
            let id = request.id.clone();
            match dispatch(request) {
                Ok(CommandOutcome { result, shutdown }) => {
                    write_response(&mut stdout, &Response::success(id, result))?;
                    if shutdown {
                        break;
                    }
                }
                Err(error) => {
                    let response = Response::failure(id, error_code(&error), error.to_string());
                    write_response(&mut stdout, &response)?;
                }
            }
        }
        Ok(())
    }
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

fn write_response(stdout: &mut impl Write, response: &Response) -> Result<()> {
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
