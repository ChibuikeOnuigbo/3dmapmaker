# Native core

`terrain-core` is a Rust port of `packages/terrain`. It exists to run the same
maths faster — as a host library for a desktop build, and as a
`wasm32-unknown-unknown` module in the browser.

## Status: written, not compiled

**Nothing in this directory has ever been compiled.** This sandbox has no Rust
toolchain, and no route to acquire one:

```
$ ls ~/.rusttoolchain/bin ~/.cargo/bin
No such file or directory
$ npm view @rustbin/rustc version
npm error 404
$ curl 'https://registry.npmjs.org/-/v1/search?text=scope:rustbin'
{"total":0}
```

`scripts/build-rust.mjs` searches PATH, `~/.cargo/bin`, `~/.rusttoolchain/bin`
and the `CARGO_HOME` / `RUST_TOOLCHAIN` overrides, finds nothing, says so, and
exits non-zero. It does not simulate a build. `python3 timer.py` records
`rust:build` as an *expected* failure, so it will report a mismatch the moment
the script starts passing for the wrong reason.

So treat this crate as reviewed-by-reading, not as verified. It is not a stub and
not pseudocode — it is a complete implementation — but it has not been through
`cargo build`, `cargo test`, or `cargo clippy`.

Nothing in the browser app depends on it. The TypeScript path is the shipping
path and always will be the fallback.

## What is here

```
Cargo.toml                 workspace + release profiles
terrain-core/
  Cargo.toml               zero dependencies, rlib + cdylib
  src/lib.rs               ToInt32/ToUint32 coercions, module docs
  src/noise.rs             Rng, Simplex2D, fbm, hash2
  src/heightfield.rs       Heightfield: storage, bilinear sampling, derivatives
  src/wasm.rs              hand-written wasm ABI
  tests/parity.rs          constants measured from the TypeScript
```

## Why zero dependencies

Nothing here needs anything external, and the maths is small enough to audit in
full. `wasm-bindgen` is deliberately not used — crates.io is unreachable here, and
a hand-written ABI is smaller and can be checked line by line against the JS glue
that calls it.

## Numerical fidelity

This is the part that is easy to get wrong and impossible to notice when it is.
JavaScript does all arithmetic in `f64` and narrows to `f32` only when a value is
stored in a `Float32Array`. The port reproduces that exactly: intermediate work is
`f64`, storage is `f32`.

The bitwise operators are the other trap. JS `|`, `^` and `>>` coerce through
`ToInt32`; `>>>` coerces through `ToUint32`. Rust's `as i32` **saturates** rather
than wrapping, so calling it where JS would coerce silently gives the wrong
answer. `to_int32` and `to_uint32` in `lib.rs` implement the real coercions, and
every wrap-around multiply is an explicit `wrapping_mul`.

## How the port is checked

`tests/parity.rs` asserts against constants that were **measured from the shipped
TypeScript** by running it under vitest and printing the values. Nothing in it is
hand-computed.

Because no Rust toolchain exists here, the other half of that contract is checked
from the JavaScript side: `packages/terrain/src/rust-parity.test.ts` re-derives
the same constants from the live TypeScript and fails if they move. That test
**does** run (12 tests, passing).

So the guarantee today is:

| | Verified? |
|---|---|
| The constants the Rust test expects match the TypeScript | **yes** — `rust-parity.test.ts`, 12 tests |
| The Rust code produces those constants | **no** — never compiled |

If the TypeScript changes, `rust-parity.test.ts` fails and tells you the Rust port
is now stale. That is the useful direction for the drift to be caught in: the
TypeScript is what ships.

## Known issues found by reading, not compiling

These were caught by review and fixed before this was written down, but they are
recorded because they are the kind of thing a compiler would have caught
instantly, and there may be more:

- **Handle underflow.** The wasm ABI uses 1-based handles so `0` is null, which
  means `handle as usize - 1` underflows on exactly the input the API promises to
  reject gracefully. In debug that is a panic; a panic inside a wasm export is an
  unrecoverable trap for the page. In release it wraps to `usize::MAX` and works
  only by accident. Now routed through a checked `slot()` helper.
- **Uninitialised memory.** `tc_alloc` used `Vec::with_capacity` + `set_len`,
  which hands the host bytes that are not valid `u8` values — undefined
  behaviour, not merely untidy. Now zero-filled.
- **A return value that lied.** `tc_heightfield_apply_edits` documented "the
  number of edits applied" but returned the number *submitted*, which differs
  whenever an index is out of range or a value is non-finite. The doc now says
  what it actually returns.

## Building it, once a toolchain exists

```bash
rustup target add wasm32-unknown-unknown
npm run rust:build     # host + wasm
npm run rust:test      # + cargo test
```

`cargo test` runs the unit tests in each module plus `tests/parity.rs`. The parity
test is the one that matters: if it fails, the port has drifted from the
TypeScript and must be reconciled rather than edited to pass.
