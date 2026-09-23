import pytest

from app.config import Settings


def test_router_reasoning_effort_defaults_to_none():
    assert Settings().router_reasoning_effort == "none"


def test_router_reasoning_effort_accepts_low_baseline():
    assert Settings(router_reasoning_effort="low").router_reasoning_effort == "low"


def test_router_reasoning_effort_rejects_unknown_value():
    with pytest.raises(ValueError, match="router_reasoning_effort"):
        Settings(router_reasoning_effort="high")
