import beta9
import beam


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
