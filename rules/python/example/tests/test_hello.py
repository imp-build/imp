import importlib.metadata
import sys


def test_typing_extensions_resolves():
    assert importlib.metadata.version("typing_extensions")


# The pythonRuntime() default in rules/python/runtime.js.
def test_runs_on_pinned_interpreter():
    assert sys.version_info[:3] == (3, 13, 0)
