import asyncio

import pytest
from PIL import Image

from backend import config, jobs, parts, processes, store


def component(directory):
    root = store.create_project('角色')
    path = directory / 'sheet.png'
    Image.new('RGB', (30, 20), 'white').save(path)
    store.update_project(root['id'], {'sheet': store.add_asset(root['id'], path, 'image')})
    part = parts.create(root['id'], '上衣', 'top')
    asset = part['references'][0]
    return store.update_project(part['id'], {'views': {label: asset for label in ('front', 'left', 'back')}})


def test_part_face_budget_persists_and_can_revert_to_global(client, isolated):
    part = component(isolated)
    route = f"/api/projects/{part['id']}"
    assert config.resolve_model_faces(part, config.load_settings()['tripo']) == 15000
    assert client.patch(route, json={'model_face_limit': 8000}).json()['model_face_limit'] == 8000
    assert client.patch(route, json={'title': '新上衣'}).json()['model_face_limit'] == 8000
    assert client.get(route).json()['model_face_limit'] == 8000
    assert store.get_project(part['parent_id']).get('model_face_limit') is None
    assert config.load_settings()['tripo']['studio_face_limit'] == 15000
    for invalid in (0, 499, 50001, 8000.5, True):
        assert client.patch(route, json={'model_face_limit': invalid}).status_code in (400, 422)
    fresh = client.patch(route, json={'model_face_limit': None}).json()
    assert fresh['model_face_limit'] is None
    settings = config.load_settings()['tripo']
    settings['studio_face_limit'] = 12000
    assert config.resolve_model_faces(fresh, settings) == 12000
    settings.update(mode='api', face_limit=40000)
    assert config.resolve_model_faces(fresh, settings) == 40000


def test_part_face_budget_obeys_current_topology_and_api_model(client, isolated, monkeypatch):
    part = component(isolated)
    route = f"/api/projects/{part['id']}"
    monkeypatch.setitem(config.DEFAULTS['tripo'], 'studio_topology', 'quad')
    assert client.patch(route, json={'model_face_limit': 30000}).status_code == 400
    assert client.patch(route, json={'split_model': True, 'model_face_limit': 30000}).status_code == 200
    assert client.patch(route, json={'split_model': False}).status_code == 400
    monkeypatch.setitem(config.DEFAULTS['tripo'], 'mode', 'api')
    monkeypatch.setitem(config.DEFAULTS['tripo'], 'model', 'tripo-p1')
    assert client.patch(route, json={'model_face_limit': 21000}).status_code == 400
    assert client.patch(route, json={'model_face_limit': 20000}).status_code == 200


@pytest.mark.parametrize('override,model,expected', [(None, 'tripo-v3.1', 50000), (8000, 'tripo-v3.1', 8000), (30000, 'tripo-p1', None)])
def test_api_submission_uses_part_budget_or_global_and_rejects_invalid_before_submit(client, isolated, monkeypatch, override, model, expected):
    part = component(isolated)
    store.update_project(part['id'], {'model_face_limit': override})
    settings = config.load_settings()
    settings['tripo'].update(mode='api', model=model)
    monkeypatch.setattr(jobs, 'load_settings', lambda: settings)
    submissions = []

    async def tripo(arguments, settings):
        submissions.append(arguments)
        return {'task_id': 'existing-task-id'}

    async def watch(*args):
        return {'assets': {}}

    monkeypatch.setattr(processes, 'tripo', tripo)
    monkeypatch.setattr(jobs, 'watch_model', watch)
    job = store.create_job(part['id'], 'model')
    asyncio.run(jobs.execute_job(job, {}))
    if expected is None:
        assert submissions == []
        assert store.get_job(job['id'])['status'] == 'failed'
    else:
        assert len(submissions) == 1
        assert f'face_limit={expected}' in submissions[0]
        assert store.get_job(job['id'])['status'] == 'success'
