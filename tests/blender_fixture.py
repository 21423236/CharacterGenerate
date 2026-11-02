"""Create a local test model from rest-space mesh copies; do NOT save the template."""
import sys
from pathlib import Path

import bpy

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend.blender_worker import export_glb

destination=Path(sys.argv[sys.argv.index("--")+1])
sources=[bpy.data.objects[name] for name in ("Mesh_Skin_Body","Mesh_Skin_Head")]
clones=[]
for source in sources:
    clone=bpy.data.objects.new("Fixture_"+source.name,source.data.copy())
    bpy.context.scene.collection.objects.link(clone)
    clone.matrix_world=source.matrix_world.copy()
    if clone.data.shape_keys:
        clone.shape_key_clear()
    clones.append(clone)
export_glb(destination,clones)
