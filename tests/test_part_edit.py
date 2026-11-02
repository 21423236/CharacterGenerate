import asyncio
import base64
import io

import httpx
from PIL import Image

from backend import config, jobs, parts, providers, store


def test_part_edit_uses_current_image_and_only_replaces_results_on_success(client, isolated, monkeypatch):
    root = store.create_project('角色')
    reference = isolated / 'reference.png'
    Image.new('RGB', (300, 200), 'white').save(reference)
    store.update_project(root['id'], {'sheet': store.add_asset(root['id'], reference, 'image')})
    part = parts.create(root['id'], '上衣', 'top')
    route = f"/api/projects/{part['id']}/jobs"
    assert client.post(route, json={'kind': 'part_edit', 'confirmed': True, 'message': '袖口收窄'}).status_code == 400
    original_path = isolated / 'current-part.png'
    Image.new('RGB', (300, 200), 'red').save(original_path)
    original = store.add_asset(part['id'], original_path, 'image')
    store.update_project(part['id'], {'part_image': original, 'sheet': original, 'views': {'front': original}, 'model': {'id': 'old-model'}})
    assert client.post(route, json={'kind': 'part_edit', 'confirmed': True, 'message': '  '}).status_code == 400
    assert client.post(route, json={'kind': 'part_edit', 'message': '袖口收窄'}).status_code == 400
    settings = config.load_settings()
    settings['image'].update(model='test', api_key='test-key')
    monkeypatch.setattr(jobs, 'load_settings', lambda: settings)
    original_client = httpx.AsyncClient
    calls = []
    result_image = io.BytesIO()
    Image.new('RGB', (300, 200), 'blue').save(result_image, format='PNG')

    def handler(request):
        calls.append(request)
        assert request.url.path.endswith('/images/edits')
        assert b'filename="current-part.png"' in request.content
        assert b'filename="reference.png"' not in request.content
        assert '袖口收窄，保留红色'.encode() in request.content
        assert b'USER EDIT REQUEST' in request.content
        if len(calls) == 1:
            return httpx.Response(503)
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(result_image.getvalue()).decode()}]})

    monkeypatch.setattr(providers.httpx, 'AsyncClient', lambda **kw: original_client(transport=httpx.MockTransport(handler), **kw))
    for attempt in range(2):
        job = store.create_job(part['id'], 'part_edit')
        asyncio.run(jobs.execute_job(job, {'message': '袖口收窄，保留红色'}))
        fresh = store.get_project(part['id'])
        if attempt == 0:
            assert store.get_job(job['id'])['status'] == 'uncertain'
            assert fresh['part_image'] == original
            assert fresh['sheet'] == original
            assert fresh['model']['id'] == 'old-model'
        else:
            assert store.get_job(job['id'])['status'] == 'success'
            assert fresh['part_image']['id'] != original['id']
            assert fresh['sheet'] is None and fresh['model'] is None and fresh['views'] == {}
            assert store.get_job(job['id'])['result']['source_asset'] == original
    assert len(calls) == 2
    assert original_path.is_file()
    assert fresh['part_edit_prompt'] == '袖口收窄，保留红色'
