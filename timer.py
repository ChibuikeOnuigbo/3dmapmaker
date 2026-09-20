#!/usr/bin/env python3
"""
timer.py — wall-clock harness for the 3DMapMaker Next toolchain.

Times each build/test/QA command end to end and records what actually happened.
Nothing here is estimated: every duration is measured by running the command and
watching it exit, and the exit status is recorded alongside it, so a command that
failed fast cannot be mistaken for a command that passed quickly.

Usage:
    python3 timer.py                 run everything, print a table
    python3 timer.py --only qa,test  run a subset
    python3 timer.py --json          machine-readable output
    python3 timer.py --repeats 3     run each command 3 times, report the median

Exit status is 0 only if every command that was expected to succeed did.
`rust:build` is allowed to fail: no Rust toolchain is installed in this
sandbox, and the script records that as a known-expected failure rather than
either hiding it or pretending the build passed.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# Commands under test, in dependency order. `expect_ok` False means a non-zero
# exit is the honest, expected outcome in this environment.
COMMANDS = [
    {
        "id": "typecheck",
        "command": ["npm", "run", "typecheck"],
        "expect_ok": True,
        "what": "TypeScript across every workspace package",
    },
    {
        "id": "test",
        "command": ["npm", "test"],
        "expect_ok": True,
        "what": "Unit + component suite (vitest)",
    },
    {
        "id": "qa",
        "command": ["node", "scripts/run-qa.mjs"],
        "expect_ok": True,
        "what": "109-check hardening/regression/audit harness",
    },
    {
        "id": "bench",
        "command": ["node", "scripts/run-bench.mjs", "--json"],
        "expect_ok": True,
        "what": "Compute-path benchmark",
    },
    {
        "id": "audit-licenses",
        "command": ["node", "scripts/audit-licenses.mjs", "--json"],
        "expect_ok": True,
        "what": "Dependency licence audit",
    },
    {
        "id": "build",
        "command": ["npm", "run", "build"],
        "expect_ok": True,
        "what": "Production bundle (vite)",
    },
    {
        "id": "rust-build",
        "command": ["node", "scripts/build-rust.mjs", "--json"],
        "expect_ok": False,
        "what": "Native core — no toolchain installed here, so this reports and exits 1",
    },
]


def run_once(command: list[str]) -> tuple[float, int, str]:
    """Run one command, returning (seconds, exit code, captured tail)."""
    env = {**os.environ, "CI": "1", "FORCE_COLOR": "0"}
    start = time.perf_counter()
    try:
        proc = subprocess.run(
            command,
            cwd=ROOT,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=1800,
        )
        code = proc.returncode
        output = proc.stdout or ""
    except subprocess.TimeoutExpired:
        return (time.perf_counter() - start, 124, "timed out after 1800 s")
    except FileNotFoundError as err:
        return (time.perf_counter() - start, 127, f"command not found: {err}")
    return (time.perf_counter() - start, code, output)


def tail(text: str, lines: int = 4) -> str:
    kept = [line for line in text.strip().splitlines() if line.strip()]
    return "\n".join(kept[-lines:])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", help="comma-separated command ids to run")
    parser.add_argument("--repeats", type=int, default=1, help="repetitions per command (median reported)")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args()

    wanted = set(args.only.split(",")) if args.only else None
    selected = [c for c in COMMANDS if wanted is None or c["id"] in wanted]
    if not selected:
        print(f"no commands matched --only {args.only}", file=sys.stderr)
        print(f"available: {', '.join(c['id'] for c in COMMANDS)}", file=sys.stderr)
        return 2

    if not args.json:
        print("3DMapMaker Next — toolchain timing harness\n")
        print(f"{len(selected)} command(s), {args.repeats} repetition(s) each\n")

    results = []
    for spec in selected:
        samples = []
        code = 0
        output = ""
        for _ in range(max(1, args.repeats)):
            seconds, code, output = run_once(spec["command"])
            samples.append(seconds)
        median = statistics.median(samples)
        expected_ok = spec["expect_ok"]
        # A command that should fail and did is a pass for our purposes, and vice
        # versa: what matters is that the outcome matches what we claimed.
        outcome_ok = (code == 0) if expected_ok else (code != 0)
        results.append(
            {
                "id": spec["id"],
                "what": spec["what"],
                "command": " ".join(spec["command"]),
                "seconds": round(median, 3),
                "min_seconds": round(min(samples), 3),
                "max_seconds": round(max(samples), 3),
                "repeats": len(samples),
                "exit_code": code,
                "expected_ok": expected_ok,
                "outcome_as_expected": outcome_ok,
                "tail": tail(output),
            }
        )
        if not args.json:
            flag = "ok" if outcome_ok else "MISMATCH"
            print(f"  [{flag:8}] {spec['id']:<16} {median:8.2f} s   exit {code}")

    total = sum(r["seconds"] for r in results)
    mismatches = [r for r in results if not r["outcome_as_expected"]]

    summary = {
        "commands": len(results),
        "repeats": max(1, args.repeats),
        "total_seconds": round(total, 3),
        "mismatches": [
            {"id": r["id"], "exit_code": r["exit_code"], "expected_ok": r["expected_ok"]} for r in mismatches
        ],
        "results": results,
    }

    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print("-" * 74)
        print(f"{'command':<18}{'median':>10}{'min':>10}{'max':>10}   expected")
        for r in results:
            expected = "exit 0" if r["expected_ok"] else "exit != 0"
            print(
                f"{r['id']:<18}{r['seconds']:>9.2f}s{r['min_seconds']:>9.2f}s{r['max_seconds']:>9.2f}s"
                f"   {expected} (got {r['exit_code']})"
            )
        print("-" * 74)
        print(f"total wall clock: {total:.2f} s across {len(results)} command(s)")
        if mismatches:
            print(f"\n{len(mismatches)} command(s) did not behave as expected:")
            for r in mismatches:
                print(f"  {r['id']}: exit {r['exit_code']} but expected "
                      f"{'success' if r['expected_ok'] else 'failure'}")
                print(f"    last output: {r['tail'].splitlines()[-1] if r['tail'] else '(none)'}")
        else:
            print("\nEvery command behaved as documented.")

    return 0 if not mismatches else 1


if __name__ == "__main__":
    raise SystemExit(main())
