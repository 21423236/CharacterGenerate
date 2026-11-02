import asyncio
import json
from pathlib import Path

import pytest
from PIL import Image

from backend import jobs, parts, providers, store


def character(tmp_path):
    p = store.create_project('角色')
    path = tmp_path / 'reference.png'
    Image.new('RGB', (300, 200), 'white').save(path)
    asset = store.add_asset(p['id'], path, 'image')
    return store.update_project(p['id'], {'sheet': asset})


def test_component_ownership_folders_and_parent_restore(client, isolated):
    root = character(isolated)
    hair = client.post(f"/api/projects/{root['id']}/parts", json={'kind': 'hair', 'title': '发型'}).json()
    assert hair['parent_id'] == root['id']
    assert hair['source_sheet_id'] == root['sheet']['id']
    assert store.get_asset(hair['references'][0]['id'], hair['id'])
    assert client.post(f"/api/projects/{hair['id']}/parts", json={'kind': 'top'}).status_code == 400
    result = parts.organize(root['id'])
    manifest = json.loads((Path(result['path']) / '资产清单.json').read_text(encoding='utf-8'))
    assert len(manifest['projects']) == 2
    assert all((Path(result['path']) / a['file']).is_file() for p in manifest['projects'] for a in p['assets'])
    job = store.create_job(hair['id'], 'image')
    assert client.delete(f"/api/projects/{root['id']}").status_code == 400
    store.update_job(job['id'], status='success')
    assert client.delete(f"/api/projects/{root['id']}").status_code == 200
    assert store.list_projects() == []
    assert client.get(f"/api/projects/{hair['id']}").status_code == 404
    client.post(f"/api/projects/{root['id']}/restore")
    assert len(store.list_projects()) == 2


def test_component_image_then_turnaround_uses_own_reference(client, isolated, monkeypatch):
    parent = character(isolated)
    hair = parts.create(parent['id'], '长发', 'hair')
    assert client.post(f"/api/projects/{hair['id']}/jobs", json={'kind': 'image', 'confirmed': True}).status_code == 400
    seen = []

    async def generate(settings, project):
        seen.append(project)
        return Image.new('RGB', (600, 400), 'white'), providers.sheet_prompt(project)

    monkeypatch.setattr(providers, 'generate_image', generate)
    for kind in ('part_image', 'image'):
        job = store.create_job(hair['id'], kind)
        asyncio.run(jobs.execute_job(job, {}))
        assert store.get_job(job['id'])['status'] == 'success'
    fresh = store.get_project(hair['id'])
    assert fresh['part_image']['id'] != fresh['sheet']['id']
    assert seen[1]['part_image'] == fresh['part_image']
    assert 'ONLY the component' in providers.sheet_prompt(seen[1])
    assert 'SAME COMPLETE character' not in providers.sheet_prompt(seen[1])
    assert 'ONE isolated' in providers.sheet_prompt(seen[0])
    assert store.get_project(parent['id'])['sheet'] == parent['sheet']


def test_assembly_requires_alignment_and_locks_children(client, isolated):
    parent = character(isolated)
    hair = parts.create(parent['id'], '头发', 'hair')
    job = store.create_job(parent['id'], 'assemble')
    with pytest.raises(ValueError, match='所属角色'):
        store.create_job(hair['id'], 'image')
    assert client.patch(f"/api/projects/{hair['id']}", json={'prompt': 'changed'}).status_code == 400
    asyncio.run(jobs.execute_job(job, {}))
    assert store.get_job(job['id'])['status'] == 'failed'
    assert '对齐预览' in store.get_job(job['id'])['message']


def test_paired_components_are_one_asset_in_both_image_stages():
    suggestions = parts.normalize_suggestions([
        {'kind': 'shoes', 'title': '左鞋'}, {'kind': 'shoes', 'title': '右鞋'},
        {'kind': 'gloves', 'title': '左手套'}, {'kind': 'gloves', 'title': '右手套'},
        {'kind': 'hair', 'title': '发型'}])
    assert suggestions == [{'kind': 'shoes', 'title': '鞋子（一双）'}, {'kind': 'gloves', 'title': '手套（一双）'}, {'kind': 'hair', 'title': '发型'}]
    for kind in ('shoes', 'gloves'):
        for stage in ('part_image', 'image'):
            prompt = providers.sheet_prompt({'part_kind': kind, 'image_stage': stage, 'title': '旧左侧部件', 'prompt': '原角色设计'})
            assert 'ONE COMPLETE PAIR' in prompt
            assert 'BOTH left and right' in prompt
