"""Launch the local-only application. No providers are called on startup."""
import json
import threading
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path


def main():
    root = Path(__file__).resolve().parent
    if not (root / "web" / "dist" / "index.html").is_file():
        raise SystemExit("UI is not built. Run install.cmd first.")
    url = "http://127.0.0.1:8765"
    try:
        with urllib.request.urlopen(url + "/api/health", timeout=2) as response:
            data = json.load(response)
        if data.get("app") == "character-forge":
            webbrowser.open(url)
            return
        raise SystemExit("Port 8765 is used by another application.")
    except (urllib.error.URLError, TimeoutError):
        pass
    import uvicorn
    # Timer only opens the browser; API mutations remain manual and require confirmation.
    threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    print("Character Forge: " + url + "  |  Ctrl+C to stop")
    uvicorn.run("backend.app:app", host="127.0.0.1", port=8765, access_log=False)


if __name__ == "__main__":
    main()
