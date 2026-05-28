"""打卡处理Agent节点函数"""
import logging
import os
import base64
import httpx
from typing import Dict

from langchain_core.messages import HumanMessage

from app.agents.checkin.state import CheckinState
from app.agents.checkin.prompts import CHECKIN_ENCOURAGEMENT_PROMPT, IMAGE_SUMMARIZE_PROMPT

logger = logging.getLogger(__name__)


def encode_image_to_base64(image_url):
    """将图片路径/URL/base64字符串统一转为base64 data URI。

    支持三种输入格式：
    - data: URIs (data:image/...;base64,...) → 直接返回
    - HTTP(S) URLs → 下载后编码
    - 本地文件路径 → 读取后编码
    """
    # 已经是完整的 data URI，直接使用
    if image_url.startswith("data:"):
        return image_url

    # 网络图片：下载后编码
    if image_url.startswith("http://") or image_url.startswith("https://"):
        try:
            resp = httpx.get(image_url, timeout=30.0)
            resp.raise_for_status()
            content_type = resp.headers.get("content-type", "image/jpeg")
            b64 = base64.b64encode(resp.content).decode("utf-8")
            return f"data:{content_type};base64,{b64}"
        except Exception as e:
            logger.error(f"下载图片失败: {e}")
            return None

    # 本地文件：读取后编码
    ext = os.path.splitext(image_url)[1].lower()
    mime_map = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }
    mime_type = mime_map.get(ext, "application/octet-stream")

    try:
        filepath = image_url if os.path.isabs(image_url) else os.path.join(os.getcwd(), image_url.lstrip("/"))
        with open(filepath, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("utf-8")
        return f"data:{mime_type};base64,{b64}"
    except Exception as e:
        logger.error(f"读取本地图片失败: {e}")
        return None


async def summarize_image_node(state: CheckinState) -> Dict:
    """使用多模态模型对打卡图片进行内容总结"""
    try:
        image_url = state.get("image_url")
        if not image_url:
            return {"image_summary": None}

        from app.llm import get_vision_model
        llm = get_vision_model()
        image_data = encode_image_to_base64(image_url)
        if image_data is None:
            return {"image_summary": None, "error": "图片处理失败，无法读取或下载"}

        message = HumanMessage(content=[
            {"type": "text", "text": IMAGE_SUMMARIZE_PROMPT},
            {"type": "image_url", "image_url": image_data},
        ])
        response = await llm.ainvoke([message])
        content = response.content
        text = content if isinstance(content, str) else str(content[0])
        return {"image_summary": text.strip()}
    except Exception as e:
        logger.error(f"summarize_image_node error: {e}")
        return {"image_summary": None, "error": str(e)}


async def generate_encouragement_node(state: CheckinState) -> Dict:
    """根据打卡内容和图片摘要生成一句简短鼓励（纯文本LLM）"""
    try:
        image_summary = state.get("image_summary")
        if image_summary:
            image_section = f"打卡图片内容：{image_summary}"
        else:
            image_section = ""

        prompt = CHECKIN_ENCOURAGEMENT_PROMPT.format(
            completed_content=state.get("completed_content", ""),
            overall_completion_rate=state.get("overall_completion_rate", 0),
            image_summary=image_section,
        )

        from app.llm import get_chat_model
        llm = get_chat_model()
        response = await llm.ainvoke([HumanMessage(content=prompt)])
        content = response.content
        text = content if isinstance(content, str) else str(content[0])
        return {"encouragement": text.strip()}
    except Exception as e:
        logger.error(f"generate_encouragement_node error: {e}")
        return {"encouragement": "今天也很努力，继续加油！", "error": str(e)}
