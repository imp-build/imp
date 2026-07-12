import importlib.metadata


def test_typing_extensions_resolves():
    assert importlib.metadata.version("typing_extensions")
