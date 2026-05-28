"""Tests for planner material extraction and upload/link endpoints."""
from io import BytesIO
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.agents.planner.materials as materials
from app.routers.plan import router


app = FastAPI()
app.include_router(router)
client = TestClient(app)


def _zip_bytes(files: dict[str, str]) -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content.encode("utf-8"))
    return buffer.getvalue()


def _pdf_bytes(text: str) -> bytes:
    content = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n"
        + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    result = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(result))
        result.extend(f"{index} 0 obj\n".encode("ascii") + obj + b"\nendobj\n")
    xref = len(result)
    result.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode("ascii"))
    for offset in offsets[1:]:
        result.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    result.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii")
    )
    return bytes(result)


class TestPublicUrlValidation:
    @pytest.mark.parametrize(
        "url",
        [
            "ftp://files.example/notes.txt",
            "http://localhost/secret",
            "http://127.0.0.1/secret",
            "http://10.1.2.3/secret",
            "http://100.64.0.1/secret",
            "http://169.254.169.254/latest/meta-data",
        ],
    )
    def test_rejects_non_http_and_non_public_hosts(self, url):
        with pytest.raises(materials.MaterialError):
            materials.validate_public_url(url, resolver=lambda _host: ["93.184.216.34"])

    def test_rejects_private_dns_results(self):
        with pytest.raises(materials.MaterialError):
            materials.validate_public_url(
                "https://materials.example/guide",
                resolver=lambda _host: ["192.168.20.4"],
            )

    def test_allows_public_dns_result(self):
        result = materials.validate_public_url(
            "https://materials.example/guide",
            resolver=lambda _host: ["93.184.216.34"],
        )
        assert result == "https://materials.example/guide"


class TestExtraction:
    def test_extracts_pdf_text(self):
        text = materials.extract_text_from_bytes("guide.pdf", _pdf_bytes("study material guide"))
        assert "study material guide" in text

    @pytest.mark.parametrize(
        ("name", "content"),
        [
            (
                "guide.docx",
                _zip_bytes({
                    "word/document.xml": (
                        '<w:document xmlns:w="urn:word"><w:body>'
                        "<w:p><w:r><w:t>中文资料 DOCX 重点</w:t></w:r></w:p>"
                        "</w:body></w:document>"
                    ),
                }),
            ),
            (
                "slides.pptx",
                _zip_bytes({
                    "ppt/slides/slide1.xml": (
                        '<p:sld xmlns:p="urn:p" xmlns:a="urn:a">'
                        "<a:t>中文资料 PPTX 要点</a:t></p:sld>"
                    ),
                }),
            ),
            (
                "topics.xlsx",
                _zip_bytes({
                    "xl/sharedStrings.xml": (
                        '<sst xmlns="urn:sheet"><si><t>中文资料 XLSX 清单</t></si></sst>'
                    ),
                    "xl/worksheets/sheet1.xml": (
                        '<worksheet xmlns="urn:sheet"><sheetData><row><c t="s">'
                        "<v>0</v></c></row></sheetData></worksheet>"
                    ),
                }),
            ),
        ],
    )
    def test_extracts_ooxml_text_without_optional_packages(self, name, content):
        text = materials.extract_text_from_bytes(name, content)
        assert "中文资料" in text

    @pytest.mark.parametrize("name", ["slides.ppt", "payload.exe"])
    def test_rejects_unsupported_extensions(self, name):
        with pytest.raises(materials.MaterialError):
            materials.extract_text_from_bytes(name, b"content")

    def test_rejects_files_larger_than_limit(self):
        with pytest.raises(materials.MaterialError) as exc:
            materials.extract_text_from_bytes("notes.txt", b"x" * (materials.MAX_FILE_BYTES + 1))
        assert exc.value.status_code == 413

    def test_html_extraction_removes_active_content_and_caps_length(self):
        html = "<style>hidden-style</style><script>hidden-script</script><p>中文资料</p>" + ("a" * 100)
        text = materials.extract_html_text(html, max_chars=12)
        assert "中文资料" in text
        assert "hidden-style" not in text
        assert "hidden-script" not in text
        assert len(text) <= 12


class TestMaterialEndpoints:
    def test_file_endpoint_summarizes_text_upload(self, monkeypatch):
        async def fake_summary(text):
            assert "中文资料" in text
            return "文本摘要"

        monkeypatch.setattr(materials, "summarize_text", fake_summary)
        response = client.post(
            "/api/planner/materials/file",
            files={"file": ("notes.txt", "中文资料：高数复习".encode(), "text/plain")},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["kind"] == "file"
        assert body["name"] == "notes.txt"
        assert body["mime_type"] == "text/plain"
        assert body["summary"] == "文本摘要"
        assert body["selected"] is True
        assert body["id"]

    @pytest.mark.parametrize(
        ("name", "mime_type", "data"),
        [
            ("cover.png", "image/png", b"\x89PNG\r\n\x1a\n"),
            ("cover.jpg", "image/jpeg", b"\xff\xd8\xff"),
            ("cover.webp", "image/webp", b"RIFF1234WEBP"),
            ("cover.gif", "image/gif", b"GIF89a"),
        ],
    )
    def test_file_endpoint_summarizes_supported_images(self, monkeypatch, name, mime_type, data):
        async def fake_image_summary(content, received_mime):
            assert content == data
            assert received_mime == mime_type
            return "图片摘要"

        monkeypatch.setattr(materials, "summarize_image_bytes", fake_image_summary)
        response = client.post(
            "/api/planner/materials/file",
            files={"file": (name, data, mime_type)},
        )
        assert response.status_code == 200
        assert response.json()["summary"] == "图片摘要"

    def test_file_endpoint_returns_400_for_unsupported_type(self):
        response = client.post(
            "/api/planner/materials/file",
            files={"file": ("bad.exe", b"binary", "application/octet-stream")},
        )
        assert response.status_code == 400

    def test_file_endpoint_returns_422_for_blank_readable_text(self):
        response = client.post(
            "/api/planner/materials/file",
            files={"file": ("blank.txt", b"   \n", "text/plain")},
        )
        assert response.status_code == 422

    def test_file_endpoint_rejects_fake_image_content(self):
        response = client.post(
            "/api/planner/materials/file",
            files={"file": ("cover.png", b"not actually a png", "image/png")},
        )
        assert response.status_code == 422

    def test_link_endpoint_fetches_and_summarizes_public_content(self, monkeypatch):
        async def fake_fetch(url):
            assert url == "https://materials.example/article"
            return "中文资料 网页正文", "text/html"

        async def fake_summary(text):
            assert text == "中文资料 网页正文"
            return "链接摘要"

        monkeypatch.setattr(materials, "fetch_public_text", fake_fetch)
        monkeypatch.setattr(materials, "summarize_text", fake_summary)
        monkeypatch.setattr(
            materials,
            "validate_public_url",
            lambda url: url,
        )
        response = client.post(
            "/api/planner/materials/link",
            json={"url": "https://materials.example/article"},
        )
        assert response.status_code == 200
        assert response.json() == {
            "id": response.json()["id"],
            "kind": "link",
            "name": "materials.example",
            "source": "https://materials.example/article",
            "mime_type": "text/html",
            "summary": "链接摘要",
            "selected": True,
        }

    def test_link_endpoint_rejects_private_url_without_fetching(self, monkeypatch):
        async def fail_fetch(_url):
            raise AssertionError("private URL must not be fetched")

        monkeypatch.setattr(materials, "fetch_public_text", fail_fetch)
        response = client.post(
            "/api/planner/materials/link",
            json={"url": "http://127.0.0.1/internal"},
        )
        assert response.status_code == 400


class _FakeSocket:
    def __init__(self, address):
        self.address = address

    def getpeername(self):
        return (self.address, 443)


class _FakeNetworkStream:
    def __init__(self, address):
        self.address = address

    def get_extra_info(self, key):
        if key == "socket":
            return _FakeSocket(self.address)
        return None


class _FakeResponse:
    def __init__(
        self,
        *,
        status_code=200,
        headers=None,
        chunks=None,
        redirect=False,
        peer="93.184.216.34",
        encoding="utf-8",
    ):
        self.status_code = status_code
        self.headers = headers or {"content-type": "text/html"}
        self._chunks = chunks or ["<p>中文资料</p>".encode("utf-8")]
        self.is_redirect = redirect
        self.extensions = {"network_stream": _FakeNetworkStream(peer)}
        self.encoding = encoding

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def aiter_bytes(self):
        for chunk in self._chunks:
            yield chunk


class _FakeAsyncClient:
    responses = []
    requested_urls = []

    def __init__(self, **_kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    def stream(self, _method, url):
        self.requested_urls.append(url)
        return self.responses.pop(0)


@pytest.mark.asyncio
class TestPublicLinkFetching:
    async def test_fetch_rejects_private_redirect(self, monkeypatch):
        _FakeAsyncClient.responses = [
            _FakeResponse(redirect=True, headers={"location": "http://127.0.0.1/internal"}),
        ]
        _FakeAsyncClient.requested_urls = []
        monkeypatch.setattr(materials.httpx, "AsyncClient", _FakeAsyncClient)
        monkeypatch.setattr(
            materials,
            "_resolved_addresses",
            lambda _hostname, _resolver=None: ["93.184.216.34"],
        )

        with pytest.raises(materials.MaterialError) as exc:
            await materials.fetch_public_text("https://materials.example/guide")

        assert exc.value.status_code == 400

    async def test_fetch_rejects_non_text_content_type(self, monkeypatch):
        _FakeAsyncClient.responses = [
            _FakeResponse(headers={"content-type": "application/pdf"}),
        ]
        _FakeAsyncClient.requested_urls = []
        monkeypatch.setattr(materials.httpx, "AsyncClient", _FakeAsyncClient)
        monkeypatch.setattr(
            materials,
            "_resolved_addresses",
            lambda _hostname, _resolver=None: ["93.184.216.34"],
        )

        with pytest.raises(materials.MaterialError) as exc:
            await materials.fetch_public_text("https://materials.example/guide")

        assert exc.value.status_code == 400

    async def test_fetch_rejects_download_larger_than_limit(self, monkeypatch):
        _FakeAsyncClient.responses = [
            _FakeResponse(chunks=[b"x" * (materials.MAX_FETCH_BYTES + 1)]),
        ]
        _FakeAsyncClient.requested_urls = []
        monkeypatch.setattr(materials.httpx, "AsyncClient", _FakeAsyncClient)
        monkeypatch.setattr(
            materials,
            "_resolved_addresses",
            lambda _hostname, _resolver=None: ["93.184.216.34"],
        )

        with pytest.raises(materials.MaterialError) as exc:
            await materials.fetch_public_text("https://materials.example/guide")

        assert exc.value.status_code == 413

    async def test_fetch_validates_actual_connected_peer(self, monkeypatch):
        _FakeAsyncClient.responses = [
            _FakeResponse(peer="127.0.0.1"),
        ]
        _FakeAsyncClient.requested_urls = []
        monkeypatch.setattr(materials.httpx, "AsyncClient", _FakeAsyncClient)
        monkeypatch.setattr(
            materials,
            "_resolved_addresses",
            lambda _hostname, _resolver=None: ["93.184.216.34"],
        )

        with pytest.raises(materials.MaterialError) as exc:
            await materials.fetch_public_text("https://materials.example/guide")

        assert exc.value.status_code == 400
