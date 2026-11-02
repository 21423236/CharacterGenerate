"""Run only inside Blender, with --disable-autoexec; never save the source template."""
import json
import math
import sys
import traceback
from pathlib import Path

import bpy
from mathutils import Euler, Matrix, Vector
from mathutils.bvhtree import BVHTree


def enum_value(owner, field, preferred):
    items = owner.bl_rna.properties[field].enum_items
    identifiers = [i.identifier for i in items]
    for value in preferred:
        if value in identifiers:
            return value
    raise ValueError(f"Unsupported Blender enum {field}: {identifiers}")


def op_enum(operator, field, preferred):
    items = operator.get_rna_type().properties[field].enum_items
    identifiers = [i.identifier for i in items]
    # Blender 5.2's glTF exporter populates this enum dynamically, so RNA is empty.
    # Read the installed exporter's actual callback instead of assuming its values.
    if not identifiers and field == "export_format":
        import io_scene_gltf2
        identifiers = [item[0] for item in io_scene_gltf2.get_format_items(None, bpy.context)]
    for value in preferred:
        if value in identifiers:
            return value
    raise ValueError(f"Unsupported operator enum: {field}")


def operator_call(operator, **kwargs):
    available = {p.identifier for p in operator.get_rna_type().properties}
    return operator(**{k: v for k, v in kwargs.items() if k in available})


def get_template(config):
    arm = bpy.data.objects.get(config["armature"])
    body = bpy.data.objects.get(config["body"])
    head = bpy.data.objects.get(config.get("head", ""))
    if not arm or arm.type != "ARMATURE":
        candidates = [o.name for o in bpy.data.objects if o.type == "ARMATURE"]
        raise ValueError(f"未找到目标骨架 {config['armature']}；可用骨架：{candidates}")
    if not body or body.type != "MESH":
        raise ValueError(f"未找到人体网格 {config['body']}")
    if config.get("head") and (not head or head.type != "MESH"):
        raise ValueError(f"未找到头部权重源 {config['head']}；不需要单独头部来源时请留空")
    sources = [body] + ([head] if head and head.type == "MESH" and head != body else [])
    for source in sources:
        if not any(m.type == "ARMATURE" and m.object == arm for m in source.modifiers):
            raise ValueError(f"权重源 {source.name} 没有绑定到 {arm.name}")
    return arm, sources


def world_bounds(objects):
    points = [obj.matrix_world @ vertex.co for obj in objects for vertex in obj.data.vertices]
    if not points:
        raise ValueError("模型没有顶点")
    return Vector(tuple(min(p[i] for p in points) for i in range(3))), Vector(tuple(max(p[i] for p in points) for i in range(3)))


def inspect(config):
    arm, sources = get_template(config)
    deform = {b.name for b in arm.data.bones if b.use_deform}
    meshes = []
    for obj in sources:
        indices = {g.index for g in obj.vertex_groups if g.name in deform}
        sums = [sum(g.weight for g in v.groups if g.group in indices) for v in obj.data.vertices]
        meshes.append({"name": obj.name, "vertices": len(obj.data.vertices), "faces": len(obj.data.polygons),
                       "unweighted": sum(s < .00001 for s in sums),
                       "max_influences": max((sum(g.weight > .000001 and g.group in indices for g in v.groups) for v in obj.data.vertices), default=0),
                       "shape_keys": len(obj.data.shape_keys.key_blocks) if obj.data.shape_keys else 0})
    low, high = world_bounds(sources)
    bones = [{"name": b.name, "parent": b.parent.name if b.parent else None, "deform": b.use_deform,
              "head": list(arm.matrix_world @ b.head_local), "tail": list(arm.matrix_world @ b.tail_local)} for b in arm.data.bones]
    upper = next((b for b in arm.data.bones if "upperarm" in b.name.lower().replace(" ", "")), None)
    pose_hint = "A-pose with arms separated from torso, straight legs and flat feet"
    if upper:
        direction = (arm.matrix_world.to_3x3() @ (upper.tail_local - upper.head_local)).normalized()
        angle = math.degrees(math.asin(min(1, abs(direction.z))))
        if angle < 15:
            pose_hint = "T-pose: both upper arms extended horizontally, palms down, straight legs, separated fingers, flat feet"
        else:
            pose_hint = f"A-pose: both upper arms angled approximately {round(angle)} degrees below horizontal, straight elbows, separated fingers, straight legs and flat feet"
    return {"blender_version": bpy.app.version_string, "armature": arm.name, "bone_count": len(bones), "bones": bones,
            "sources": meshes, "height": round(high.z - low.z, 4), "bounds": [list(low), list(high)], "pose_hint": pose_hint,
            "actions": [a.name for a in bpy.data.actions],
            "armatures": [o.name for o in bpy.data.objects if o.type == "ARMATURE"],
            "mesh_candidates": [o.name for o in bpy.data.objects if o.type == "MESH"],
            "warnings": ["权重源存在未绑定顶点"] if any(m["unweighted"] for m in meshes) else []}


def clear_selection():
    for obj in bpy.context.view_layer.objects:
        obj.select_set(False)


def export_glb(path, objects):
    clear_selection()
    for obj in objects:
        obj.hide_set(False)
        obj.select_set(True)
    bpy.context.view_layer.objects.active = next((o for o in objects if o.type == "MESH"), objects[0])
    operator_call(bpy.ops.export_scene.gltf, filepath=str(path), use_selection=True,
                  export_format=op_enum(bpy.ops.export_scene.gltf, "export_format", ["GLB"]),
                  export_animations=False, export_skins=any(o.type == "ARMATURE" for o in objects), export_yup=True)


def import_and_align(request, sources):
    path = Path(request["model"])
    if path.suffix.lower() not in (".glb", ".fbx"):
        raise ValueError("仅支持自包含 GLB 或 FBX 模型")
    before = set(bpy.data.objects)
    if path.suffix.lower() == ".glb":
        bpy.ops.import_scene.gltf(filepath=str(path))
    else:
        bpy.ops.import_scene.fbx(filepath=str(path))
    imported = set(bpy.data.objects) - before
    meshes = [o for o in imported if o.type == "MESH"]
    if not meshes:
        raise ValueError("导入的模型不包含网格")
    if sum(len(o.data.vertices) for o in meshes) > 500000:
        raise ValueError("模型超过 50 万顶点，请先减面后再蒙皮")
    transform = request.get("transform", {})
    rotation = Euler(tuple(math.radians(float(transform.get(f"rotation_{a}", 0))) for a in "xyz")).to_matrix().to_4x4()
    for obj in meshes:
        matrix = rotation @ obj.matrix_world.copy()
        obj.parent = None
        obj.data = obj.data.copy()
        if obj.data.shape_keys:
            obj.shape_key_clear()
        for vertex in obj.data.vertices:
            vertex.co = matrix @ vertex.co
        obj.matrix_world = Matrix.Identity(4)
        for modifier in list(obj.modifiers):
            if modifier.type == "ARMATURE":
                obj.modifiers.remove(modifier)
        obj.vertex_groups.clear()
    for obj in imported - set(meshes):
        bpy.data.objects.remove(obj, do_unlink=True)
    source_low, source_high = world_bounds(sources)
    low, high = world_bounds(meshes)
    if high.z - low.z < 0.000001:
        raise ValueError("模型高度为零，请调整导入朝向")
    factor = (source_high.z - source_low.z) / (high.z - low.z) * float(transform.get("scale", 1))
    pivot = Vector(((low.x + high.x) / 2, (low.y + high.y) / 2, low.z))
    target = Vector(((source_low.x + source_high.x) / 2, (source_low.y + source_high.y) / 2, source_low.z))
    target += Vector(tuple(float(transform.get(f"offset_{a}", 0)) for a in "xyz"))
    for obj in meshes:
        for vertex in obj.data.vertices:
            vertex.co = (vertex.co - pivot) * factor + target
        obj.data.update()
        obj.name = "Forge_" + obj.name
    return meshes


def source_geometry(sources, deform):
    vertices, polygons, weights = [], [], []
    for source in sources:
        offset = len(vertices)
        vertices.extend(source.matrix_world @ v.co for v in source.data.vertices)
        index_name = {g.index: g.name for g in source.vertex_groups if g.name in deform}
        weights.extend({index_name[g.group]: g.weight for g in v.groups if g.group in index_name and g.weight > .000001} for v in source.data.vertices)
        source.data.calc_loop_triangles()
        polygons.extend(tuple(offset + i for i in tri.vertices) for tri in source.data.loop_triangles)
    if not polygons:
        raise ValueError("权重源没有可用于插值的表面")
    return vertices, polygons, weights


def barycentric(point, a, b, c):
    ab, ac, ap = b - a, c - a, point - a
    d00, d01, d11, d20, d21 = ab.dot(ab), ab.dot(ac), ac.dot(ac), ap.dot(ab), ap.dot(ac)
    denominator = d00 * d11 - d01 * d01
    if abs(denominator) < 1e-16:
        return [1, 0, 0]
    v = (d11 * d20 - d01 * d21) / denominator
    w = (d00 * d21 - d01 * d20) / denominator
    values = [max(0, 1 - v - w), max(0, v), max(0, w)]
    total = sum(values)
    return [value / total for value in values]


def transfer_weights(meshes, sources, arm, limit):
    deform = {b.name for b in arm.data.bones if b.use_deform}
    vertices, triangles, weights = source_geometry(sources, deform)
    tree = BVHTree.FromPolygons(vertices, triangles, all_triangles=True)
    source_low, source_high = world_bounds(sources)
    threshold = (source_high.z - source_low.z) * .08
    report = []
    identifiers = [i.identifier for i in bpy.types.VertexGroup.bl_rna.functions["add"].parameters["type"].enum_items]
    replace = next(i for i in identifiers if i == "REPLACE")
    for obj in meshes:
        groups = {name: obj.vertex_groups.new(name=name) for name in sorted(deform)}
        empty, far = 0, 0
        for vertex in obj.data.vertices:
            point, normal, triangle_id, distance = tree.find_nearest(obj.matrix_world @ vertex.co)
            if point is None:
                empty += 1
                continue
            if distance > threshold:
                far += 1
            ids = triangles[triangle_id]
            factors = barycentric(point, *(vertices[i] for i in ids))
            merged = {}
            for index, coefficient in zip(ids, factors):
                for name, weight in weights[index].items():
                    merged[name] = merged.get(name, 0) + coefficient * weight
            selected = sorted(((n, w) for n, w in merged.items() if w > .000001), key=lambda item: item[1], reverse=True)[:limit]
            total = sum(w for _, w in selected)
            if total <= .000001:
                empty += 1
                continue
            for name, weight in selected:
                groups[name].add([vertex.index], weight / total, replace)
        # Modifier.new has no enum RNA property; obtain supported types from the base modifier type.
        modifier = obj.modifiers.new(name="Forge skin", type=enum_value(bpy.types.Modifier, "type", ["ARMATURE"]))
        modifier.object = arm
        matrix = obj.matrix_world.copy()
        obj.parent = arm
        obj.matrix_world = matrix
        report.append({"name": obj.name, "vertices": len(obj.data.vertices), "unweighted": empty,
                       "far_from_source": far, "max_influences": limit})
    return report


def silhouette_proxy(sources):
    objects = []
    mat = bpy.data.materials.new("Forge reference")
    mat.use_nodes = True
    shader = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    shader.inputs["Base Color"].default_value = (.16, .65, .45, 1)
    shader.inputs["Roughness"].default_value = .9
    for source in sources:
        clone = bpy.data.objects.new("Reference_" + source.name, source.data.copy())
        bpy.context.scene.collection.objects.link(clone)
        clone.matrix_world = source.matrix_world.copy()
        if clone.data.shape_keys:
            clone.shape_key_clear()
        clone.data.materials.clear()
        clone.data.materials.append(mat)
        objects.append(clone)
    return objects


def run(request):
    config = request["config"]
    if request["action"] == "inspect":
        return inspect(config)
    arm, sources = get_template(config)
    output = Path(request["output"])
    output.mkdir(parents=True, exist_ok=True)
    template_path = Path(bpy.data.filepath).resolve()
    if (output / "character.blend").resolve() == template_path:
        raise ValueError("不能覆盖源模板")
    # Rest-space data is used for BOTH source geometry and target binding.
    arm.data.pose_position = enum_value(arm.data, "pose_position", ["REST"])
    for source in sources:
        if source.data.shape_keys:
            for key in source.data.shape_keys.key_blocks:
                key.value = 0
    meshes = import_and_align(request, sources)
    export_glb(output / "aligned.glb", meshes)
    proxy = silhouette_proxy(sources)
    export_glb(output / "reference.glb", proxy)
    for obj in proxy:
        bpy.data.objects.remove(obj, do_unlink=True)
    if request["action"] == "align":
        return {"aligned": str(output / "aligned.glb"), "reference": str(output / "reference.glb"), "message": "请先确认朝向、关节位置和静止姿态，再执行蒙皮。"}
    weight_report = transfer_weights(meshes, sources, arm, int(config.get("influences", 4)))
    warnings = ["表面最近点插值不能保证披风、裙摆、手指等区域正确，请检查测试姿势。"]
    if any(item["unweighted"] for item in weight_report):
        warnings.append("存在未绑定顶点，当前结果需要人工修正，不应直接用于生产。")
    if any(item["far_from_source"] for item in weight_report):
        warnings.append("部分顶点距人体超过身高的 8%，宽松服饰或对齐误差可能导致错误权重。")
    # Preserve original meshes, rig, shape keys and actions in the copied file.
    original_meshes = [o for o in bpy.context.scene.objects if o.type == "MESH" and o not in meshes]
    for obj in original_meshes:
        obj.hide_render = True
        obj.hide_set(True)
    arm.data.pose_position = enum_value(arm.data, "pose_position", ["POSE"])
    # Pause action/NLA only in the copy. Keep even the formerly active action from
    # becoming an orphan that Blender would omit on save/reload.
    for action in bpy.data.actions:
        action.use_fake_user = True
    active_action = None
    if arm.animation_data:
        if arm.animation_data.action:
            active_action = arm.animation_data.action.name
            arm.animation_data.action = None
        for track in arm.animation_data.nla_tracks:
            track.mute = True
    for bone in arm.pose.bones:
        bone.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()
    export_glb(output / "character.glb", meshes + [arm])
    tests = []
    for label, search, axis, degrees in (("elbow", "forearm", 0, 65), ("knee", "calf", 0, 45), ("shoulder", "upperarm", 1, 35)):
        changed = []
        for bone in arm.pose.bones:
            if search in bone.name.lower().replace(" ", ""):
                bone.matrix_basis = Matrix.Rotation(math.radians(degrees), 4, Vector(tuple(1 if i == axis else 0 for i in range(3))))
                changed.append(bone)
        if changed:
            bpy.context.view_layer.update()
            path = output / f"test_{label}.glb"
            # Apply the pose only in the export, so browser preview can show actual deformation.
            snapshots = []
            depsgraph = bpy.context.evaluated_depsgraph_get()
            for obj in meshes:
                evaluated = obj.evaluated_get(depsgraph)
                data = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
                snapshot = bpy.data.objects.new("Test_" + obj.name, data)
                bpy.context.scene.collection.objects.link(snapshot)
                snapshot.matrix_world = obj.matrix_world.copy()
                snapshots.append(snapshot)
            export_glb(path, snapshots)
            for obj in snapshots:
                bpy.data.objects.remove(obj, do_unlink=True)
            tests.append({"name": label, "path": str(path)})
            for bone in changed:
                bone.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()
    clear_selection()
    for obj in meshes + [arm]:
        obj.hide_set(False)
        obj.select_set(True)
    bpy.context.view_layer.objects.active = arm
    operator_call(bpy.ops.export_scene.fbx, filepath=str(output / "character.fbx"), use_selection=True,
                  bake_anim=False, add_leaf_bones=False)
    # Never call save_mainfile. Save only to a new per-job directory.
    bpy.ops.wm.save_as_mainfile(filepath=str(output / "character.blend"), copy=True)
    return {"blend": str(output / "character.blend"), "glb": str(output / "character.glb"), "fbx": str(output / "character.fbx"),
            "weights": weight_report, "warnings": warnings, "tests": tests,
            "previous_active_action": active_action, "actions_preserved": [a.name for a in bpy.data.actions]}


if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:]
    request_path, report_path = map(Path, args)
    try:
        result = run(json.loads(request_path.read_text(encoding="utf-8")))
        report_path.write_text(json.dumps({"ok": True, "result": result}, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as exc:
        report_path.write_text(json.dumps({"ok": False, "error": str(exc), "traceback": traceback.format_exc()}, ensure_ascii=False), encoding="utf-8")
        traceback.print_exc()
        sys.exit(1)
