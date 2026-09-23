"""Small HTTP surface used to create and restore a call."""

from fastapi import APIRouter, HTTPException, Request

from app.api.contracts import AUDIO_FORMAT


router = APIRouter(prefix="/api/v1")


@router.get("/health")
async def health():
    return {"status": "ok"}


@router.get("/catalog/scenarios")
async def scenarios(request: Request):
    return [{"scenario_id": row.scenario_id, "name": row.name, "priority": row.priority}
            for row in request.app.state.sessions.catalog.scenarios.values()]


@router.post("/sessions")
async def create_session(request: Request):
    manager = request.app.state.sessions
    session = manager.create()
    return {"session_id": session.session_id,
            "ws_path": f"/api/v1/sessions/{session.session_id}/stream",
            "audio_input": AUDIO_FORMAT, "audio_output": AUDIO_FORMAT,
            "as_of_date": manager.catalog.mock_backend["meta"]["as_of_date"]}


@router.get("/sessions/{session_id}")
async def get_session(session_id: str, request: Request):
    session = request.app.state.sessions.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session.summary()
