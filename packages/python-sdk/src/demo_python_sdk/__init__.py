__version__ = "0.1.0"


def python_hello_world(name: str = "release-action") -> str:
    return f"hello {name} from the demo Python SDK"


def get_sdk_version() -> str:
    return __version__
