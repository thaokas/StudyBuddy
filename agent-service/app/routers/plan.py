"""Planner agent router — SSE streaming endpoint for multi-turn plan generation."""
import json
import logging
import asyncio
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from app.agents.planner import materials
from app.agents.planner.graph import run_planner_turn
from app.routers.schemas import PlannerChatRequest, PlannerMaterialLinkRequest, PlannerMaterialResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/planner", tags=["计划生成"])

# Track cancellable tasks: thread_id -> asyncio.Event
_cancel_events: dict[str, asyncio.Event] = {}


def _material_response(
    *,
    kind: str,
    name: str,
    summary: str,
    mime_type: str | None = None,
    source: str | None = None,
) -> PlannerMaterialResponse:
    return PlannerMaterialResponse(
        id=str(uuid4()),
        kind=kind,
        name=name,
        source=source,
        mime_type=mime_type,
        summary=summary[:materials.MAX_SUMMARY_CHARS],
        selected=True,
    )


@router.post("/materials/file", response_model=PlannerMaterialResponse)
async def add_planner_file_material(file: UploadFile = File(...)):
    """Extract and summarize one uploaded planner material."""
    name = Path(file.filename or "upload").name
    try:
        content = await file.read(materials.MAX_FILE_BYTES + 1)
        if len(content) > materials.MAX_FILE_BYTES:
            raise materials.MaterialError(413, "Uploaded material exceeds the 10 MiB limit.")
        mime_type = materials.image_mime_type(name, content)
        if mime_type:
            summary = await materials.summarize_image_bytes(content, mime_type)
        else:
            text = await run_in_threadpool(materials.extract_text_from_bytes, name, content)
            if not text.strip():
                raise materials.MaterialError(422, "Uploaded material has no readable text.")
            summary = await materials.summarize_text(text)
            mime_type = file.content_type
        return _material_response(
            kind="file",
            name=name,
            mime_type=mime_type,
            summary=summary,
        )
    except materials.MaterialError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except Exception as exc:
        logger.error("Material file summarization error: %s", exc, exc_info=True)
        raise HTTPException(status_code=502, detail="Material could not be summarized.") from exc


@router.post("/materials/link", response_model=PlannerMaterialResponse)
async def add_planner_link_material(request: PlannerMaterialLinkRequest):
    """Fetch and summarize public web material for the planner."""
    try:
        url = materials.validate_public_url(request.url)
        text, mime_type = await materials.fetch_public_text(url)
        if not text.strip():
            raise materials.MaterialError(422, "Linked material has no readable text.")
        summary = await materials.summarize_text(text)
        return _material_response(
            kind="link",
            name=urlparse(url).hostname or url,
            source=url,
            mime_type=mime_type,
            summary=summary,
        )
    except materials.MaterialError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except Exception as exc:
        logger.error("Material link summarization error: %s", exc, exc_info=True)
        raise HTTPException(status_code=502, detail="Material link could not be processed.") from exc


@router.post("/chat")
async def planner_chat(req: PlannerChatRequest):
    """SSE streaming endpoint for multi-turn plan generation.

    Accepts a user message and optional prior state, streams SSE events as the
    LangGraph planner agent processes the turn.
    """
    thread_id = req.thread_id or "default"
    cancel_event = asyncio.Event()
    _cancel_events[thread_id] = cancel_event

    async def event_stream():
        try:
            async for event in run_planner_turn(
                user_message=req.message,
                existing_state=req.state,
            ):
                # Check for cancellation
                if cancel_event.is_set():
                    yield f"event: error\ndata: {json.dumps({'message': '已取消'}, ensure_ascii=False)}\n\n"
                    yield "event: done\ndata: {}\n\n"
                    return

                yield f"event: {event['event']}\ndata: {json.dumps(event['data'], ensure_ascii=False)}\n\n"

                # Small yield to allow cancellation check
                await asyncio.sleep(0)

        except Exception as e:
            logger.error(f"SSE stream error: {e}", exc_info=True)
            yield f"event: error\ndata: {json.dumps({'message': str(e)}, ensure_ascii=False)}\n\n"
            yield "event: done\ndata: {}\n\n"
        finally:
            _cancel_events.pop(thread_id, None)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/chat/cancel")
async def cancel_planner_chat(req: dict):
    """Cancel an in-progress planner chat."""
    thread_id = req.get("thread_id", "default")
    cancel_event = _cancel_events.get(thread_id)
    if cancel_event:
        cancel_event.set()
        return {"status": "cancelled", "thread_id": thread_id}
    return {"status": "not_found", "thread_id": thread_id}
