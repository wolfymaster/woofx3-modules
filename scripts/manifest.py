#!/usr/bin/env python3
"""Read and write top-level fields in a module manifest.json.

`set-version` rewrites the version in place, touching only the bytes of that one
value. Re-encoding the whole document with json.dump would reformat every
manifest on the first bump and bury the real change in whitespace noise, so the
top-level key is located by a depth-aware scan and spliced.

Usage:
    manifest.py get <file> <field>
    manifest.py set-version <file> <version>
"""

import json
import re
import sys

SEMVER = re.compile(
    r"^(?P<major>0|[1-9]\d*)\.(?P<minor>0|[1-9]\d*)\.(?P<patch>0|[1-9]\d*)"
    r"(?:-(?P<prerelease>[0-9A-Za-z.-]+))?"
    r"(?:\+(?P<build>[0-9A-Za-z.-]+))?$"
)


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except OSError as exc:
        die(f"reading {path}: {exc}")
    try:
        return text, json.loads(text)
    except json.JSONDecodeError as exc:
        die(f"{path} is not valid JSON: {exc}")


def find_top_level_value(text, key):
    """Return (start, end) byte offsets of the value for a top-level `key`.

    Walks the document tracking string state and brace depth so a `"version"`
    nested inside a widget or action is never mistaken for the module's own.
    """
    depth = 0
    i = 0
    n = len(text)
    in_string = False
    escaped = False
    pending_key = None

    while i < n:
        ch = text[i]

        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
                if depth == 1:
                    pending_key = (string_start, i)
            i += 1
            continue

        if ch == '"':
            in_string = True
            string_start = i
            i += 1
            continue

        if ch in "{[":
            depth += 1
            pending_key = None
        elif ch in "}]":
            depth -= 1
            pending_key = None
        elif ch == ":" and depth == 1 and pending_key is not None:
            name = text[pending_key[0] + 1 : pending_key[1]]
            if name == key:
                j = i + 1
                while j < n and text[j] in " \t\r\n":
                    j += 1
                if j < n and text[j] == '"':
                    k = j + 1
                    esc = False
                    while k < n:
                        if esc:
                            esc = False
                        elif text[k] == "\\":
                            esc = True
                        elif text[k] == '"':
                            break
                        k += 1
                    return j + 1, k
                die(f"top-level {key!r} is not a string")
            pending_key = None
        elif ch == ",":
            pending_key = None

        i += 1

    return None


def main(argv):
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 1

    cmd, path = argv[1], argv[2]

    if cmd == "get":
        if len(argv) != 4:
            die("usage: manifest.py get <file> <field>")
        _, data = load(path)
        value = data.get(argv[3])
        if value is None:
            return 1
        print(value)
        return 0

    if cmd == "set-version":
        if len(argv) != 4:
            die("usage: manifest.py set-version <file> <version>")
        version = argv[3]
        if not SEMVER.match(version):
            die(f"{version!r} is not a valid semantic version")
        text, data = load(path)
        if "version" not in data:
            die(f"{path} has no top-level version field")
        span = find_top_level_value(text, "version")
        if span is None:
            die(f"could not locate the top-level version field in {path}")
        start, end = span
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text[:start] + version + text[end:])
        return 0

    die(f"unknown command {cmd!r}")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
