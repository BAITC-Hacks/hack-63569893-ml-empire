"""Application composition; importing or checking health requires no API key."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.http import router as http_router
from app.api.ws import router as ws_router
from app.audio.stt import Transcriber
from app.audio.tts import Synthesizer
from app.catalog import Catalog
from app.config import Settings
from app.sessions import SessionManager


_DEFAULT = object()


def create_app(*, settings=None, catalog=None, processor=None,
               transcriber_factory=Transcriber, synthesizer=_DEFAULT) -> FastAPI:
    settings = settings or Settings()
    catalog = catalog or Catalog.load(settings.data_dir)
    if processor is None:
        graph = None

        async def processor(session_id, turn_id, text):
            nonlocal graph
            from langgraph.checkpoint.memory import InMemorySaver
            from app.actions import ActionEngine
            from app.graph import build_graph, run_turn
            from app.router import LLMRouter

            if graph is None:
                graph = build_graph(catalog, LLMRouter(catalog, settings=settings),
                                    ActionEngine(catalog), InMemorySaver())
            return await run_turn(graph, session_id, turn_id, text)

    owns_synthesizer = synthesizer is _DEFAULT

    @asynccontextmanager
    async def lifespan(app):
        try:
            yield
        finally:
            if owns_synthesizer:
                await app.state.synthesizer.aclose()

    app = FastAPI(title="Voice Router", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=[settings.frontend_origin],
                       allow_methods=["GET", "POST"], allow_headers=["Content-Type"])
    app.state.settings = settings
    app.state.sessions = SessionManager(catalog, processor)
    app.state.transcriber_factory = transcriber_factory
    app.state.synthesizer = Synthesizer() if owns_synthesizer else synthesizer
    app.include_router(http_router)
    app.include_router(ws_router)
    return app


app = create_app()
