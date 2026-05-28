"""Safe extraction and summarization helpers for planner reference materials."""
from __future__ import annotations

import base64
from io import BytesIO
import ipaddress
from pathlib import Path
import socket
from typing import Callable, Iterable
from urllib.parse import urljoin, urlparse
import xml.etree.ElementTree as ET
import zipfile

from bs4 import BeautifulSoup
import httpx
from pypdf import PdfReader


MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_FETCH_BYTES = 2 * 1024 * 1024
MAX_EXTRACTED_CHARS = 50000
MAX_SUMMARY_CHARS = 1500
MAX_ZIP_ENTRIES = 200
MAX_ZIP_ENTRY_BYTES = 5 * 1024 * 1024
MAX_ZIP_TOTAL_BYTES = 20 * 1024 * 1024

IMAGE_MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}
TEXT_EXTENSIONS = {".txt", ".md", ".pdf", ".docx", ".pptx", ".xlsx", ".html", ".htm"}


class MaterialError(ValueError):
    """A readable material validation or processing error for API translation."""

    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


def _public_ip(address: str) -> None:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError as exc:
        raise MaterialError(400, "Material URL resolved to an invalid IP address.") from exc
    if not ip.is_global:
        raise MaterialError(400, "Material URL must resolve only to public IP addresses.")


def _resolved_addresses(
    hostname: str,
    resolver: Callable[[str], Iterable[str]] | None,
) -> list[str]:
    if resolver is not None:
        return [str(address) for address in resolver(hostname)]
    try:
        results = socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise MaterialError(400, "Material URL hostname could not be resolved.") from exc
    return list({result[4][0] for result in results})


def validate_public_url(
    url: str,
    resolver: Callable[[str], Iterable[str]] | None = None,
) -> str:
    """Validate an HTTP(S) URL whose hostname resolves only to public IPs."""
    parsed = urlparse(url)
    if parsed.scheme.lower() not in {"http", "https"}:
        raise MaterialError(400, "Material URL must use http or https.")
    if not parsed.hostname:
        raise MaterialError(400, "Material URL must include a hostname.")
    if parsed.username or parsed.password:
        raise MaterialError(400, "Material URL must not contain credentials.")

    hostname = parsed.hostname.lower()
    if hostname == "localhost" or hostname.endswith(".localhost"):
        raise MaterialError(400, "Local material URLs are not allowed.")
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        addresses = _resolved_addresses(hostname, resolver)
        if not addresses:
            raise MaterialError(400, "Material URL hostname did not resolve to an address.")
        for address in addresses:
            _public_ip(address)
        return url
    _public_ip(hostname)
    return url


def _text_nodes(root: ET.Element) -> list[str]:
    return [
        node.text.strip()
        for node in root.iter()
        if node.tag.rsplit("}", 1)[-1] == "t" and node.text and node.text.strip()
    ]


def _read_xml(archive: zipfile.ZipFile, name: str) -> ET.Element:
    try:
        _assert_safe_zip_member(archive, name)
        return ET.fromstring(archive.read(name))
    except (KeyError, ET.ParseError) as exc:
        raise MaterialError(422, "The uploaded Office document could not be read.") from exc


def _assert_safe_zip(archive: zipfile.ZipFile) -> None:
    infos = archive.infolist()
    if len(infos) > MAX_ZIP_ENTRIES:
        raise MaterialError(413, "The uploaded Office document is too complex to process.")
    total_size = 0
    for info in infos:
        total_size += info.file_size
        if info.file_size > MAX_ZIP_ENTRY_BYTES or total_size > MAX_ZIP_TOTAL_BYTES:
            raise MaterialError(413, "The uploaded Office document is too large after extraction.")


def _assert_safe_zip_member(archive: zipfile.ZipFile, name: str) -> None:
    info = archive.getinfo(name)
    if info.file_size > MAX_ZIP_ENTRY_BYTES:
        raise MaterialError(413, "The uploaded Office document is too large after extraction.")


def _extract_docx(content: bytes) -> str:
    with zipfile.ZipFile(BytesIO(content)) as archive:
        _assert_safe_zip(archive)
        return "\n".join(_text_nodes(_read_xml(archive, "word/document.xml")))


def _extract_pptx(content: bytes) -> str:
    with zipfile.ZipFile(BytesIO(content)) as archive:
        _assert_safe_zip(archive)
        slide_names = sorted(
            name for name in archive.namelist()
            if name.startswith("ppt/slides/slide") and name.endswith(".xml")
        )
        return "\n".join(
            text
            for name in slide_names
            for text in _text_nodes(_read_xml(archive, name))
        )


def _extract_xlsx(content: bytes) -> str:
    with zipfile.ZipFile(BytesIO(content)) as archive:
        _assert_safe_zip(archive)
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = _read_xml(archive, "xl/sharedStrings.xml")
            for string_item in root.iter():
                if string_item.tag.rsplit("}", 1)[-1] == "si":
                    shared.append(" ".join(_text_nodes(string_item)))

        values: list[str] = []
        sheets = sorted(
            name for name in archive.namelist()
            if name.startswith("xl/worksheets/") and name.endswith(".xml")
        )
        for sheet_name in sheets:
            root = _read_xml(archive, sheet_name)
            for cell in root.iter():
                if cell.tag.rsplit("}", 1)[-1] != "c":
                    continue
                inline_text = _text_nodes(cell)
                if inline_text:
                    values.extend(inline_text)
                    continue
                value = next(
                    (
                        node.text
                        for node in cell.iter()
                        if node.tag.rsplit("}", 1)[-1] == "v" and node.text is not None
                    ),
                    None,
                )
                if value is None:
                    continue
                if cell.attrib.get("t") == "s":
                    try:
                        values.append(shared[int(value)])
                    except (IndexError, ValueError):
                        continue
                else:
                    values.append(value)
        return "\n".join(values)


def extract_html_text(html: str, max_chars: int = MAX_EXTRACTED_CHARS) -> str:
    """Strip active HTML content and return compact visible text."""
    soup = BeautifulSoup(html, "html.parser")
    for element in soup(["script", "style"]):
        element.decompose()
    return " ".join(soup.get_text(" ", strip=True).split())[:max_chars]


def extract_text_from_bytes(name: str, content: bytes) -> str:
    """Extract bounded text from a supported uploaded text or document file."""
    if len(content) > MAX_FILE_BYTES:
        raise MaterialError(413, "Uploaded material exceeds the 10 MiB limit.")
    suffix = Path(name).suffix.lower()
    if suffix not in TEXT_EXTENSIONS:
        raise MaterialError(400, "Unsupported material file type.")
    try:
        if suffix in {".txt", ".md"}:
            text = content.decode("utf-8", errors="ignore")
        elif suffix == ".pdf":
            text = "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(content)).pages)
        elif suffix == ".docx":
            text = _extract_docx(content)
        elif suffix == ".pptx":
            text = _extract_pptx(content)
        elif suffix == ".xlsx":
            text = _extract_xlsx(content)
        else:
            text = extract_html_text(content.decode("utf-8", errors="ignore"))
    except MaterialError:
        raise
    except (OSError, ValueError, zipfile.BadZipFile, ET.ParseError) as exc:
        raise MaterialError(422, "The uploaded material could not be read.") from exc
    return text[:MAX_EXTRACTED_CHARS]


def image_mime_type(name: str, content: bytes | None = None) -> str | None:
    expected = IMAGE_MIME_TYPES.get(Path(name).suffix.lower())
    if not expected or content is None:
        return expected
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        actual = "image/png"
    elif content.startswith(b"\xff\xd8\xff"):
        actual = "image/jpeg"
    elif content.startswith((b"GIF87a", b"GIF89a")):
        actual = "image/gif"
    elif len(content) >= 12 and content.startswith(b"RIFF") and content[8:12] == b"WEBP":
        actual = "image/webp"
    else:
        raise MaterialError(422, "Uploaded image does not match a supported image format.")
    if actual != expected:
        raise MaterialError(400, "Uploaded image extension does not match its content.")
    return actual


def _validate_response_peer(response: httpx.Response) -> None:
    network_stream = response.extensions.get("network_stream")
    socket_obj = network_stream.get_extra_info("socket") if network_stream is not None else None
    if socket_obj is None:
        raise MaterialError(502, "Material link destination could not be verified.")
    peer = socket_obj.getpeername()
    if not peer:
        raise MaterialError(502, "Material link destination could not be verified.")
    _public_ip(peer[0])


def _model_text(response: object) -> str:
    content = getattr(response, "content", "")
    if isinstance(content, str):
        return content.strip()
    return str(content).strip()


async def summarize_text(text: str) -> str:
    """Summarize text with the configured chat model."""
    from langchain_core.messages import HumanMessage
    from app.llm import get_chat_model

    prompt = (
        "请用不超过1500字概括这份备考材料，提取考试范围、重点和可用于制定计划的信息：\n\n"
        + text[:MAX_EXTRACTED_CHARS]
    )
    response = await get_chat_model().ainvoke([HumanMessage(content=prompt)])
    return _model_text(response)[:MAX_SUMMARY_CHARS]


async def summarize_image_bytes(content: bytes, mime_type: str) -> str:
    """Summarize an uploaded material image with the configured vision model."""
    from langchain_core.messages import HumanMessage
    from app.llm import get_vision_model

    data_uri = f"data:{mime_type};base64,{base64.b64encode(content).decode('ascii')}"
    message = HumanMessage(content=[
        {"type": "text", "text": "请识别这份备考材料图片中的文字与学习重点，并简要总结。"},
        {"type": "image_url", "image_url": {"url": data_uri}},
    ])
    response = await get_vision_model().ainvoke([message])
    return _model_text(response)[:MAX_SUMMARY_CHARS]


async def fetch_public_text(url: str) -> tuple[str, str]:
    """Fetch bounded public HTML/plaintext content, validating every redirect hop."""
    current_url = validate_public_url(url)
    timeout = httpx.Timeout(10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            for _ in range(6):
                async with client.stream("GET", current_url) as response:
                    _validate_response_peer(response)
                    if response.is_redirect:
                        location = response.headers.get("location")
                        if not location:
                            raise MaterialError(502, "Material link redirect is missing a target.")
                        current_url = validate_public_url(urljoin(current_url, location))
                        continue
                    if response.status_code >= 400:
                        raise MaterialError(502, "Material link could not be downloaded.")
                    mime_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
                    if mime_type not in {"text/html", "text/plain"}:
                        raise MaterialError(400, "Material link must return HTML or plain text.")
                    chunks: list[bytes] = []
                    size = 0
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > MAX_FETCH_BYTES:
                            raise MaterialError(413, "Downloaded material exceeds the 2 MiB limit.")
                        chunks.append(chunk)
                    raw_text = b"".join(chunks).decode(response.encoding or "utf-8", errors="replace")
                    text = extract_html_text(raw_text) if mime_type == "text/html" else raw_text
                    return text[:MAX_EXTRACTED_CHARS], mime_type
    except MaterialError:
        raise
    except httpx.HTTPError as exc:
        raise MaterialError(502, "Material link could not be downloaded.") from exc
    raise MaterialError(502, "Material link redirected too many times.")
