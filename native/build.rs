use std::{env, path::PathBuf, process::Command};
fn main() {
    assert_eq!(
        env::var("CARGO_CFG_TARGET_OS").unwrap(),
        "macos",
        "APFS MVP requires macOS"
    );
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    assert!(Command::new("cc")
        .args(["-Wall", "-Wextra", "-Werror", "-O2", "-c", "cow.c", "-o"])
        .arg(out.join("cow.o"))
        .status()
        .unwrap()
        .success());
    assert!(Command::new("ar")
        .arg("rcs")
        .arg(out.join("libcow.a"))
        .arg(out.join("cow.o"))
        .status()
        .unwrap()
        .success());
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=cow");
    println!("cargo:rerun-if-changed=cow.c");
}
