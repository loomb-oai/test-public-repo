__version__ = "0.1.0"


def python_gday(name: str = "release-action") -> str:
    return f"g'day {name} from the demo Python SDK"


def get_sdk_version() -> str:
    return __version__
