"""Run with Blender --background --factory-startup --python this_file -- output_dir."""
import hashlib
import json
import sys
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend import blender_worker as worker

output = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
output.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.object.armature_add()
arm = bpy.context.object
arm.name = 'TestRig'
bpy.ops.object.mode_set(mode='EDIT')
arm.data.edit_bones[0].name = 'Root'
head = arm.data.edit_bones.new('Head')
head.head, head.tail = (0, 0, 1.5), (0, 0, 2)
head.parent = arm.data.edit_bones['Root']
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 1))
body = bpy.context.object
body.name = 'SourceBody'
body.scale = (.5, .3, 2)
body.vertex_groups.new(name='Root').add(list(range(8)), 1.0, 'REPLACE')
body.modifiers.new('Armature', 'ARMATURE').object = arm
bpy.ops.mesh.primitive_cube_add(size=1)
component = bpy.context.object
worker.export_glb(output / 'component.glb', [component])
bpy.data.objects.remove(component, do_unlink=True)
template = output / 'template.blend'
bpy.ops.wm.save_as_mainfile(filepath=str(template))
before = hashlib.sha256(template.read_bytes()).hexdigest()
config = {'armature': arm.name, 'body': body.name, 'head': '', 'influences': 4}
common = {'model': str(output / 'component.glb'), 'transform': {}}
result = worker.run({'action': 'assemble', 'config': config, 'output': str(output / 'assembled'), 'models': [
    {**common, 'title': 'Hair', 'part_kind': 'hair', 'binding_mode': 'rigid', 'binding_bone': 'Head'},
    {**common, 'title': 'Coat', 'part_kind': 'coat', 'binding_mode': 'surface'}]})
assert len(result['weights']) == 2
assert all(item['unweighted'] == 0 for item in result['weights'])
assert all(Path(result[key]).is_file() for key in ('blend', 'glb', 'fbx'))
assert hashlib.sha256(template.read_bytes()).hexdigest() == before
hair = next(obj for obj in bpy.data.objects if obj.type == 'MESH' and obj.name.startswith('Hair_'))
assert hair.vertex_groups.get('Head')
assert all(len(v.groups) == 1 and v.groups[0].weight == 1 for v in hair.data.vertices)
import struct
raw = Path(result['glb']).read_bytes()
size = struct.unpack_from('<I', raw, 12)[0]
gltf = json.loads(raw[20:20 + size])
assert len([n for n in gltf['nodes'] if 'mesh' in n and 'skin' in n]) == 2
print(json.dumps({'ok': True, 'separate_meshes': 2, 'rigid_hair': True, 'source_unchanged': True}))
