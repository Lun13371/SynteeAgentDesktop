use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const SAMPLE_SIZE: usize = 4096;
const FNV_OFFSET: u32 = 2_166_136_261;
const FNV_PRIME: u32 = 16_777_619;

/// Matches Syntee's quickHash: FNV-1a over head + tail + file size.
pub fn quick_hash(path: &Path, size: u64) -> u32 {
    let Ok(mut file) = File::open(path) else { return 0 };
    let mut hash = FNV_OFFSET;
    let mut buffer = [0_u8; SAMPLE_SIZE];
    let head_len = size.min(SAMPLE_SIZE as u64) as usize;

    if file.read_exact(&mut buffer[..head_len]).is_ok() {
        hash = update(hash, &buffer[..head_len]);
    }
    if size > (SAMPLE_SIZE * 2) as u64
        && file.seek(SeekFrom::Start(size - SAMPLE_SIZE as u64)).is_ok()
        && file.read_exact(&mut buffer).is_ok()
    {
        hash = update(hash, &buffer);
    }

    hash ^ (size as u32)
}

fn update(mut hash: u32, bytes: &[u8]) -> u32 {
    for byte in bytes {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::update;

    #[test]
    fn fnv_hash_is_deterministic() {
        assert_eq!(update(2_166_136_261, b"syntee"), update(2_166_136_261, b"syntee"));
        assert_ne!(update(2_166_136_261, b"syntee"), update(2_166_136_261, b"sidecar"));
    }
}
