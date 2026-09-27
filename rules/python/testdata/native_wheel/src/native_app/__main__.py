import os
import platform
import re
import sys
from importlib.metadata import version

try:
    import _cffi_backend
    from cffi import FFI
except ImportError as exc:
    build_version = os.environ.get("IMP_PYTHON_BUILD_VERSION", "unknown")
    raise RuntimeError(
        "native wheel interpreter mismatch: "
        f"build={build_version} run={platform.python_version()}: {exc}"
    ) from exc


def native_abi():
    match = re.search(r"cpython-\d+", _cffi_backend.__file__)
    if match is None:
        raise RuntimeError(
            f"could not identify cffi build interpreter in {_cffi_backend.__file__}"
        )
    return match.group(0)


def native_result():
    ffi = FFI()
    return ffi.new("int *", 7)[0]


def main():
    build_version = os.environ["IMP_PYTHON_BUILD_VERSION"]
    run_version = platform.python_version()
    run_abi = f"cpython-{sys.version_info.major}{sys.version_info.minor}"
    build_abi = native_abi()
    if build_abi != run_abi:
        raise RuntimeError(
            "native wheel interpreter mismatch: "
            f"build={build_version} ({build_abi}) run={run_version} ({run_abi})"
        )
    print(
        f"native wheel ok: build={build_version} ({build_abi}) "
        f"run={run_version} ({run_abi}) "
        f"cffi={version('cffi')} "
        f"ffi_value={native_result()}"
    )


if __name__ == "__main__":
    main()
