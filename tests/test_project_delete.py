from backend import store


def test_delete_restore_preserves_generated_assets(client, isolated):
    project = client.post('/api/projects', json={'title': '删除测试'}).json()
    pid = project['id']
    model = isolated / 'model.glb'
    model.write_bytes(b'preserved model')
    asset = store.add_asset(pid, model, 'model')
    store.update_project(pid, {'model': asset})
    assert client.delete(f'/api/projects/{pid}').status_code == 200
    assert client.get('/api/projects').json() == []
    assert client.get(f'/api/projects/{pid}').status_code == 404
    assert client.patch(f'/api/projects/{pid}', json={'prompt': 'late update'}).status_code == 404
    restored = client.post(f'/api/projects/{pid}/restore').json()
    assert restored['model'] == asset
    assert model.read_bytes() == b'preserved model'
    assert len(client.get('/api/projects').json()) == 1


def test_busy_project_cannot_be_deleted(client):
    pid = store.create_project('运行中')['id']
    job = store.create_job(pid, 'image')
    assert client.delete(f'/api/projects/{pid}').status_code == 400
    assert store.get_project(pid)['title'] == '运行中'
    store.update_job(job['id'], status='success')
    assert client.delete(f'/api/projects/{pid}').status_code == 200
    assert client.delete('/api/projects/missing').status_code == 404
