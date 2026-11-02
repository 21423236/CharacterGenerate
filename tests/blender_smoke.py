"""Optional real Blender smoke test. Generates only new files in data/smoke-test."""
import asyncio
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend import processes
from backend.config import DATA, ROOT, load_settings


async def main():
    config=load_settings()["blender"]
    template=processes.template_path(config)
    before=hashlib.sha256(template.read_bytes()).hexdigest()
    destination=DATA/"smoke-test"
    destination.mkdir(parents=True,exist_ok=True)
    from PIL import Image, ImageDraw
    sheet=Image.new("RGB",(900,600),"white")
    draw=ImageDraw.Draw(sheet)
    for center,width in ((150,100),(450,60),(750,100)):
        draw.rectangle((center-width/2,40,center+width/2,560),fill="#843d45")
    sheet.save(destination/"sheet.png")
    model=destination/"fixture.glb"
    await processes.run_process([processes.blender_executable(config),"--background","--factory-startup","--disable-autoexec",template,"--python-exit-code","1",
                                 "--python",ROOT/"tests"/"blender_fixture.py","--",model])
    common={"config":config,"model":str(model),"transform":{}}
    result={}
    for action in ("inspect","align","bind"):
        output=destination/action
        result[action]=await processes.blender({**common,"action":action,"output":str(output)},output)
    assert Path(result["bind"]["blend"]).is_file()
    assert Path(result["bind"]["fbx"]).is_file()
    assert Path(result["bind"]["glb"]).is_file()
    assert all(weight["unweighted"]==0 for weight in result["bind"]["weights"])
    assert len(result["bind"]["tests"])==3
    saved=await processes.run_process([processes.blender_executable(config),"--background","--factory-startup","--disable-autoexec",
                                      result["bind"]["blend"],"--python-exit-code","1","--python",ROOT/"tests"/"verify_saved.py","--",
                                      destination/"bind"/"blender_request.json"])
    assert result["inspect"]["bones"]==saved["bones"]
    assert set(result["inspect"]["actions"]) <= set(saved["actions"])
    assert result["inspect"]["sources"]==saved["sources"]
    assert hashlib.sha256(template.read_bytes()).hexdigest()==before,"SOURCE TEMPLATE CHANGED!"
    (destination/"summary.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"ok":True,"source_unchanged":True,"bones":result["inspect"]["bone_count"],
                      "weights":result["bind"]["weights"],"output":str(destination)},ensure_ascii=True))


if __name__=="__main__":
    asyncio.run(main())
