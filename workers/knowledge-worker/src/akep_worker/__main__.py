from __future__ import annotations

import json
import sys

from .handler import handle_task


def main() -> int:
    for line_number, line in enumerate(sys.stdin, start=1):
        if not line.strip():
            continue
        try:
            task = json.loads(line)
            result = handle_task(task)
        except (ValueError, json.JSONDecodeError) as error:
            print(f"line {line_number}: {error}", file=sys.stderr)
            return 2
        sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
