"""Beam SDK exports, loaded only when an application uses them."""

from importlib import import_module

import beta9


__all__ = [
    "Map",
    "Image",
    "Queue",
    "Volume",
    "CloudBucket",
    "CloudBucketConfig",
    "task_queue",
    "function",
    "endpoint",
    "asgi",
    "realtime",
    "Container",
    "env",
    "PythonVersion",
    "GpuType",
    "Output",
    "QueueDepthAutoscaler",
    "experimental",
    "DatabaseServingConfig",
    "DurableDisk",
    "ImageBuildError",
    "Pool",
    "RemoteExecutionError",
    "SandboxFileSearchResult",
    "Service",
    "ServingConfig",
    "TaskPolicy",
    "schedule",
    "integrations",
    "Bot",
    "BotContext",
    "BotEventType",
    "BotLocation",
    "Pod",
    "PodInstance",
    "Client",
    "Task",
    "Deployment",
    "schema",
    "Sandbox",
    "SandboxInstance",
    "SandboxProcess",
    "SandboxProcessManager",
    "SandboxProcessResponse",
    "SandboxProcessStream",
    "SandboxProcessError",
    "SandboxConnectionError",
    "SandboxFileInfo",
    "SandboxFileSystem",
    "SandboxFileSystemError",
    "SandboxFilePosition",
    "SandboxFileSearchMatch",
    "SandboxFileSearchRange",
]

# Inspect the export table without importing VM (and its SDK dependencies).
if "VM" in vars(beta9) or (
    "__getattr__" in vars(beta9) and "VM" in getattr(beta9, "__all__", ())
):
    __all__.append("VM")


def __getattr__(name):
    if name not in __all__:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    if name == "Client":
        value = import_module(".client.client", __name__).Client
    elif name == "PodInstance":
        value = import_module("beta9.abstractions.pod").PodInstance
    else:
        value = getattr(beta9, name)
    globals()[name] = value
    return value


def __dir__():
    return sorted(set(globals()) | set(__all__))
