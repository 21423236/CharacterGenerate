import json
import sys
from pathlib import Path

import bpy

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend.blender_worker import inspect

request=json.loads(Path(sys.argv[sys.argv.index("--")+1]).read_text(encoding="utf-8"))
result=inspect(request["config"])
arm=bpy.data.objects[request["config"]["armature"]]
deform={bone.name for bone in arm.data.bones if bone.use_deform}
result["generated_meshes"]=[]
for obj in bpy.data.objects:
    if obj.type!="MESH" or not obj.name.startswith("Forge_"):
        continue
    indices={group.index for group in obj.vertex_groups if group.name in deform}
    sums=[sum(group.weight for group in vertex.groups if group.group in indices) for vertex in obj.data.vertices]
    influences=[sum(group.weight>.000001 and group.group in indices for group in vertex.groups) for vertex in obj.data.vertices]
    assert all(abs(total-1)<.00001 for total in sums)
    assert max(influences)<=request["config"]["influences"]
    assert any(mod.type=="ARMATURE" and mod.object==arm for mod in obj.modifiers)
    result["generated_meshes"].append(obj.name)
assert result["generated_meshes"]
assert all(action.use_fake_user for action in bpy.data.actions)
print(json.dumps(result,ensure_ascii=True))
