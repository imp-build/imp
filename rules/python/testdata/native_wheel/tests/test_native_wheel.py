import platform
import re
import sys

import _cffi_backend
from cffi import FFI


def test_native_wheel_runs_on_pinned_interpreter():
    assert platform.python_version() == "3.13.0"
    assert re.search(
        rf"cpython-{sys.version_info.major}{sys.version_info.minor}",
        _cffi_backend.__file__,
    )
    ffi = FFI()
    assert ffi.new("int *", 7)[0] == 7
