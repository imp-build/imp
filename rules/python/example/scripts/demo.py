"""A standalone script run by pythonSources(), not part of the hello app.

Prints its arguments so `imp run ... -- <args>` is verifiable end to end.
"""

import sys


def main() -> None:
    print("demo script args:", " ".join(sys.argv[1:]))


if __name__ == "__main__":
    main()
