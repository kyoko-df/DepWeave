use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    ffi::CString,
    fs::{self, File},
    io::{self, BufRead, Read, Write},
    os::unix::{
        fs::MetadataExt,
        io::{AsRawFd, FromRawFd},
    },
    path::Path,
};

extern "C" {
    fn dw_open(path: *const libc::c_char) -> libc::c_int;
    fn dw_clone(
        source: libc::c_int,
        directory: libc::c_int,
        name: *const libc::c_char,
    ) -> libc::c_int;
    fn dw_exchange(
        directory: libc::c_int,
        a: *const libc::c_char,
        b: *const libc::c_char,
    ) -> libc::c_int;
    fn dw_metadata(source: libc::c_int, target: libc::c_int) -> libc::c_int;
    fn dw_volume(path: *const libc::c_char, available: *mut u64) -> libc::c_int;
    fn dw_storage(fd: libc::c_int, private_size: *mut u64, clone_id: *mut u64) -> libc::c_int;
}
type Result<T> = std::result::Result<T, String>;
fn cstr(s: &str) -> Result<CString> {
    CString::new(s).map_err(|_| "NUL in path".into())
}
fn sys(rc: i32) -> Result<()> {
    if rc < 0 {
        Err(io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}
fn open(path: &str) -> Result<File> {
    let fd = unsafe { dw_open(cstr(path)?.as_ptr()) };
    sys(fd)?;
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn hash(file: &mut File) -> Result<String> {
    use std::io::Seek;
    file.rewind().map_err(|e| e.to_string())?;
    let mut sha = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        sha.update(&buf[..n]);
    }
    Ok(format!("{:x}", sha.finalize()))
}
fn signature(m: &fs::Metadata) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}:{}:{}:{}",
        m.dev(),
        m.ino(),
        m.len(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
        m.mode(),
        m.uid(),
        m.gid()
    )
}
fn info(path: &str) -> Result<Value> {
    let f = open(path)?;
    let m = f.metadata().map_err(|e| e.to_string())?;
    let (mut private, mut clone) = (0, 0);
    let ok = unsafe { dw_storage(f.as_raw_fd(), &mut private, &mut clone) } == 0;
    let mut s: libc::stat = unsafe { std::mem::zeroed() };
    sys(unsafe { libc::fstat(f.as_raw_fd(), &mut s) })?;
    Ok(
        json!({"inode":m.ino().to_string(), "device":m.dev().to_string(), "size":m.len(), "allocatedBytes":m.blocks()*512,
        "privateBytes":if ok {Some(private)} else {None}, "cloneId":if ok {Some(clone.to_string())} else {None},
        "signature":signature(&m), "mode":m.mode(), "links":m.nlink(), "flags":s.st_flags}),
    )
}
fn volume(path: &str) -> Result<Value> {
    let mut bytes = 0;
    let rc = unsafe { dw_volume(cstr(path)?.as_ptr(), &mut bytes) };
    sys(rc)?;
    Ok(json!({"apfs":rc==1, "availableBytes":bytes}))
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().ok_or_else(|| format!("Missing {key}"))
}
fn clone_to(source: &mut File, target: &str, expected: &str) -> Result<()> {
    let path = Path::new(target);
    let dir = open(
        path.parent()
            .ok_or("No parent")?
            .to_str()
            .ok_or("Non UTF-8 path")?,
    )?;
    let name = cstr(
        path.file_name()
            .ok_or("No name")?
            .to_str()
            .ok_or("Non UTF-8 name")?,
    )?;
    let before = signature(&source.metadata().map_err(|e| e.to_string())?);
    sys(unsafe { dw_clone(source.as_raw_fd(), dir.as_raw_fd(), name.as_ptr()) })?;
    let result = (|| {
        let mut clone = open(target)?;
        if hash(&mut clone)? != expected
            || signature(&source.metadata().map_err(|e| e.to_string())?) != before
        {
            return Err("Source changed or content mismatch".into());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(target);
    }
    result
}
fn replace(v: &Value) -> Result<Value> {
    let (src, target, temp, expected) = (
        text(v, "source")?,
        text(v, "target")?,
        text(v, "temp")?,
        text(v, "hash")?,
    );
    let mut original = open(target)?;
    let m = original.metadata().map_err(|e| e.to_string())?;
    if !m.is_file() || m.nlink() != 1 || m.mode() & 0o7000 != 0 {
        return Err("Unsupported file type, hardlink or special mode".into());
    }
    if signature(&m) != text(v, "signature")? || hash(&mut original)? != expected {
        return Err("Target changed".into());
    }
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    sys(unsafe { libc::fstat(original.as_raw_fd(), &mut stat) })?;
    if stat.st_flags != 0 {
        return Err("Files with BSD flags are skipped".into());
    }
    let parent = Path::new(target).parent().ok_or("No parent")?;
    if Path::new(temp).parent() != Some(parent) {
        return Err("Temporary file must be a sibling".into());
    }
    let mut source = open(src)?;
    if !source.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Source is not regular".into());
    }
    clone_to(&mut source, temp, expected)?;
    let result = (|| {
        let clone = open(temp)?;
        sys(unsafe { libc::fchmod(clone.as_raw_fd(), 0o600) })?;
        sys(unsafe { dw_metadata(original.as_raw_fd(), clone.as_raw_fd()) })?;
        let cm = clone.metadata().map_err(|e| e.to_string())?;
        if cm.mode() != m.mode()
            || cm.uid() != m.uid()
            || cm.gid() != m.gid()
            || cm.mtime() != m.mtime()
            || cm.mtime_nsec() != m.mtime_nsec()
        {
            return Err("Metadata mismatch".into());
        }
        let mut check = open(target)?;
        if signature(&check.metadata().map_err(|e| e.to_string())?) != signature(&m)
            || hash(&mut check)? != expected
        {
            return Err("Target changed before commit".into());
        }
        clone.sync_all().map_err(|e| e.to_string())?;
        let dir = open(parent.to_str().ok_or("Non UTF-8 path")?)?;
        let tn = cstr(Path::new(target).file_name().unwrap().to_str().unwrap())?;
        let tmpn = cstr(Path::new(temp).file_name().unwrap().to_str().unwrap())?;
        sys(unsafe { dw_exchange(dir.as_raw_fd(), tn.as_ptr(), tmpn.as_ptr()) })?;
        // After exchange, temp is the old target. A killed process leaves both
        // copies intact; the caller's durable journal enables safe cleanup.
        let mut displaced = open(temp)?;
        if displaced.metadata().map_err(|e| e.to_string())?.ino() != m.ino()
            || hash(&mut displaced)? != expected
        {
            sys(unsafe { dw_exchange(dir.as_raw_fd(), tn.as_ptr(), tmpn.as_ptr()) })?;
            return Err("Target changed during commit; exchange rolled back".into());
        }
        fs::remove_file(temp).map_err(|e| e.to_string())?;
        let _ = dir.sync_all();
        info(target)
    })();
    // On error retain temp: the journal resolves before-swap / after-swap
    // states by checking both contents. Never blindly unlink an old target.
    result
}
fn run(v: &Value) -> Result<Value> {
    match text(v, "op")? {
        "info" => info(text(v, "path")?),
        "volume" => volume(text(v, "path")?),
        "replace" => replace(v),
        "clone" => {
            let mut f = open(text(v, "source")?)?;
            if !f.metadata().map_err(|e| e.to_string())?.is_file() {
                return Err("Not a regular file".into());
            }
            clone_to(&mut f, text(v, "target")?, text(v, "hash")?)?;
            if v["readonly"].as_bool() == Some(true) {
                let clone = open(text(v, "target")?)?;
                sys(unsafe { libc::fchmod(clone.as_raw_fd(), 0o444) })?;
            }
            info(text(v, "target")?)
        }
        _ => Err("Unknown operation".into()),
    }
}
fn main() {
    for line in io::stdin().lock().lines() {
        let result = line
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str::<Value>(&s).map_err(|e| e.to_string()))
            .and_then(|v| run(&v));
        let reply = match result {
            Ok(data) => json!({"ok":true,"data":data}),
            Err(error) => json!({"ok":false,"error":error}),
        };
        println!("{reply}");
        if io::stdout().flush().is_err() {
            break;
        }
    }
}
