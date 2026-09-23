"""Application startup prepares the default runtime without processing a turn."""

from fastapi.testclient import TestClient

from app import graph as graph_module
from app.main import create_app


def test_default_graph_prewarms_during_startup_without_provider_or_session(monkeypatch):
    real_build_graph = graph_module.build_graph
    built = []

    def record_build(*args):
        graph = real_build_graph(*args)
        built.append(graph)
        return graph

    def unexpected_provider(**kwargs):
        raise AssertionError("Startup must not construct a provider model")

    monkeypatch.setattr(graph_module, "build_graph", record_build)
    monkeypatch.setattr("app.router.ChatOpenAI", unexpected_provider)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    app = create_app(synthesizer=None)
    assert built == []
    with TestClient(app) as client:
        assert len(built) == 1
        assert client.get("/api/v1/health").json() == {"status": "ok"}
        assert client.app.state.sessions._sessions == {}
    assert len(built) == 1


def test_injected_processor_skips_default_graph_prewarm(monkeypatch):
    def unexpected_build(*args):
        raise AssertionError("Injected processor must skip default graph assembly")

    async def injected_processor(session_id, turn_id, text):
        raise AssertionError("Startup must not process a turn")

    monkeypatch.setattr(graph_module, "build_graph", unexpected_build)
    with TestClient(create_app(processor=injected_processor, synthesizer=None)) as client:
        assert client.get("/api/v1/health").json() == {"status": "ok"}
