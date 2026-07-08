import importlib.metadata

import typing_extensions  # noqa: F401  (imported to prove the dependency resolves)


def main():
    version = importlib.metadata.version("typing_extensions")
    print(f"hello from imp python-app (typing_extensions {version})")


if __name__ == "__main__":
    main()
