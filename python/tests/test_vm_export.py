import importlib

import beta9
import beam
import pytest


def test_vm_export_is_lazy_and_resolves_beta9(monkeypatch):
    expected = type("VM", (), {})
    monkeypatch.setattr(beta9, "VM", expected, raising=False)
    previous = beam.__dict__.pop("VM", None)
    try:
        assert beam.VM is expected
    finally:
        beam.__dict__.pop("VM", None)
        if previous is not None:
            beam.__dict__["VM"] = previous


@pytest.mark.parametrize("available", [False, True])
def test_vm_export_matches_installed_beta9(monkeypatch, available):
    expected = type("VM", (), {})
    previous = beam.__dict__.pop("VM", None)
    try:
        with monkeypatch.context() as patch:
            if available:
                patch.setattr(beta9, "VM", expected, raising=False)
            else:
                patch.delattr(beta9, "VM", raising=False)
            importlib.reload(beam)
            assert ("VM" in beam.__all__) == available
            exports = {}
            exec("from beam import *", exports)
            assert exports.get("VM") is (expected if available else None)
            if available:
                assert beam.VM is expected
            else:
                with pytest.raises(AttributeError):
                    getattr(beam, "VM")
    finally:
        beam.__dict__.pop("VM", None)
        importlib.reload(beam)
        if previous is not None:
            beam.__dict__["VM"] = previous
